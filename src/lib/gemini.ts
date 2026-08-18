const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';

import { getLanguageNameEn } from './languages';
import { progress, m } from './progress';
import { stripRepetitionRuns, lastTimestampSeconds, secondsToLabel, tailRepetitionRun } from './text-cleanup';
import { sleep, fetchWithTimeout, isCancelledError, throwIfCancelled } from './pipeline-control';
import { sanitizeDuration } from './duration';
import { forEachSSE } from './sse';

// ---------------------------------------------------------------------------
// Modelos, límites de free tier y cadenas
// Actualiza esta tabla si Google cambia los límites o los IDs de modelo
// ---------------------------------------------------------------------------

/**
 * Límites del FREE TIER por modelo (AI Studio / Gemini API).
 *  - rpm: requests por minuto · tpm: tokens por minuto · rpd: requests por día
 *  - maxOutput: tokens máximos de salida del modelo
 *
 * El reparto de papeles sale directamente de esta tabla:
 *  - Flash Lite (15 RPM · 500 RPD) es lo ÚNICO que aguanta N peticiones
 *    seguidas: transcribe todos los fragmentos.
 *  - Flash (5 RPM · 20 RPD) sólo da para una petición grande: redacta.
 *
 * Aquí NO hay ningún Pro, y no es un olvido: en el free tier de la API de
 * Gemini los Pro salen con cuota CERO (2.5 Pro y 3.1 Pro, 0/0 en RPM, TPM y
 * RPD). Se probó a dejarlos como último recurso y lo único que podían aportar
 * era un 429 al final de una espera. Si algún día vuelven a tener cuota, se
 * añaden aquí y a la cadena de redacción.
 */
export const GEMINI_MODEL_LIMITS: Record<string, { rpm: number; tpm: number; rpd: number; maxOutput: number }> = {
    'gemini-3.5-flash-lite':  { rpm: 15, tpm: 250_000, rpd: 500, maxOutput: 65536 },
    'gemini-3.1-flash-lite':  { rpm: 15, tpm: 250_000, rpd: 500, maxOutput: 65536 },
    'gemini-3.7-flash':       { rpm: 5,  tpm: 250_000, rpd: 20,  maxOutput: 65536 },
    'gemini-3.6-flash':       { rpm: 5,  tpm: 250_000, rpd: 20,  maxOutput: 65536 },
    'gemini-3.5-flash':       { rpm: 5,  tpm: 250_000, rpd: 20,  maxOutput: 65536 },
    'gemini-3-flash-preview': { rpm: 5,  tpm: 250_000, rpd: 20,  maxOutput: 65536 },
};

/** Límites por defecto si el modelo no está en la tabla (conservadores). */
const DEFAULT_MODEL_LIMITS = { rpm: 5, tpm: 250_000, rpd: 20, maxOutput: 8192 };

const limitsFor = (model: string) => GEMINI_MODEL_LIMITS[model] ?? DEFAULT_MODEL_LIMITS;

/**
 * TRANSCRIPCIÓN — sólo Flash Lite.
 *
 * Antes la cadena de transcripción caía a los Flash cuando los Lite fallaban,
 * y ahí estaba el peor fallo del sistema: un audio de dos horas son doce
 * fragmentos, y los Flash admiten VEINTE peticiones AL DÍA. Bastaban dos
 * audios largos para dejar la cuenta sin modelos hasta el día siguiente, justo
 * en el paso que más peticiones consume y menos calidad necesita.
 */
export const GEMINI_TRANSCRIPTION_CHAIN = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
] as const;

/**
 * REDACCIÓN — un solo Flash, una sola petición.
 *
 * Aquí sí compensa el modelo grande: es UNA petición por audio (cabe de sobra
 * en 20 RPD) y es la que decide la calidad de lo que el usuario acaba leyendo.
 */
export const GEMINI_ASSEMBLY_CHAIN = [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
] as const;

/**
 * ÚLTIMO RECURSO de la redacción: los mismos Flash Lite que transcriben.
 *
 * Los Flash tienen 20 peticiones al día CADA UNO, y se gastan. Cuando los
 * cuatro se agotan —cosa que pasa antes de lo que parece si se procesan
 * varios audios en un día— la alternativa no es un Pro (no hay cuota gratis
 * para ninguno), sino redactar con un Lite: los apuntes salen algo menos
 * finos, pero salen. Antes, ese mismo caso terminaba en pantalla de error con
 * la transcripción hecha y tirada a la basura.
 */
export const GEMINI_NOTES_FALLBACK_CHAIN = GEMINI_TRANSCRIPTION_CHAIN;

/** Compat: la cadena "de transcripción" es la que se recorre por defecto. */
export const GEMINI_MODEL_CHAIN = GEMINI_TRANSCRIPTION_CHAIN;
export const TRANSCRIPTION_FALLBACK_MODELS = GEMINI_TRANSCRIPTION_CHAIN;
export const ORGANIZATION_FALLBACK_MODELS = GEMINI_ASSEMBLY_CHAIN;

/**
 * Cadena de modelos que empieza por el elegido.
 *
 * Elegir un modelo significa "prueba este primero", no "muere con este". La
 * versión anterior lo interpretaba de la segunda forma: con un modelo fijo se
 * hacían 3 intentos y se abandonaba, sin tocar el resto. Un 503 es del
 * servidor, no del modelo, y los demás suelen estar sanos.
 */
export function chainStartingWith(model: string | undefined, chain: readonly string[]): string[] {
    if (!model || model === 'auto') return [...chain];
    return [model, ...chain.filter((m) => m !== model)];
}

/** Lo que ofrece el selector: transcribir es cosa de los Lite. */
export const GEMINI_TRANSCRIPTION_MODELS = [
    { id: 'auto', label: 'Auto', desc: '3.5 Flash Lite + respaldo' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', desc: '15 RPM · 500 RPD' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', desc: '15 RPM · 500 RPD' },
] as const;

/**
 * Tokens máximos de OUTPUT para operaciones de REDACCIÓN.
 * Derivado de la tabla de límites: se aprovecha el máximo real del modelo.
 */
export const ORGANIZATION_MAX_OUTPUT_TOKENS: Record<string, number> = Object.fromEntries(
    Object.entries(GEMINI_MODEL_LIMITS).map(([model, l]) => [model, l.maxOutput])
);

/** Tokens máximos de OUTPUT para TRANSCRIPCIÓN. */
export const TRANSCRIPTION_MAX_OUTPUT_TOKENS = 32768;

/**
 * Presupuesto de tokens de salida ajustado a la duración del audio.
 * ~300 tokens por minuto de habla, con la mitad de margen encima.
 */
export function outputTokenBudget(durationSeconds: number, maxOutput: number = TRANSCRIPTION_MAX_OUTPUT_TOKENS): number {
    const minutes = Math.max(1, durationSeconds / 60);
    const estimatedTokens = Math.ceil(minutes * 300);
    const calculated = Math.max(4096, Math.ceil(estimatedTokens * 1.5));
    return Math.min(calculated, maxOutput);
}

/**
 * Coste aproximado en tokens de input por segundo de audio en Gemini (~32 tok/s).
 * Se usa para no reventar el TPM cuando se transcriben chunks en paralelo.
 */
const AUDIO_INPUT_TOKENS_PER_SECOND = 32;

/** Margen de seguridad sobre el TPM (no consumir el 100% de la ventana). */
const TPM_SAFETY_FACTOR = 0.8;

/**
 * Techo de simultaneidad que NO se puede rebasar sin comerse un 429: el mínimo
 * entre lo que permite el RPM y lo que permite el TPM.
 *
 * Un fragmento de 10 min ≈ 600 s × 32 tok/s ≈ 19K tokens de entrada, más el
 * presupuesto de salida. Con 250K TPM salen ~8 simultáneos; con los antiguos
 * fragmentos de 20 min eran 5.
 */
export function maxParallelChunks(model: string, chunkSeconds: number): number {
    const l = limitsFor(model);
    const outputBudget = outputTokenBudget(chunkSeconds, TRANSCRIPTION_MAX_OUTPUT_TOKENS);
    const tokensPerChunk = Math.max(1, chunkSeconds * AUDIO_INPUT_TOKENS_PER_SECOND + outputBudget);
    const byTpm = Math.floor((l.tpm * TPM_SAFETY_FACTOR) / tokensPerChunk);
    return Math.max(1, Math.min(l.rpm, byTpm));
}

/**
 * Simultaneidad en automático. Deliberadamente por debajo del techo: cada
 * reintento es una petición más que no estaba en la cuenta, y una tanda que
 * roza el límite convierte cualquier reintento en un 429 en cadena.
 */
export const AUTO_CONCURRENCY_CAP = 4;
/** Lo máximo que se le deja elegir a mano a quien quiera apretar. */
export const MAX_USER_CONCURRENCY = 8;

/**
 * Cuántos fragmentos se lanzan a la vez.
 *
 * `requested` es lo que pidió el usuario (0 o undefined = automático). Se
 * respeta salvo que se salga del techo real de RPM/TPM, porque pasar de ahí no
 * es "ir más rápido", es garantizar 429s y acabar tardando más.
 */
export function resolveConcurrency(
    model: string,
    chunkSeconds: number,
    chunkCount: number,
    requested?: number,
): { value: number; capped: boolean; ceiling: number } {
    const ceiling = maxParallelChunks(model, chunkSeconds);
    const wanted = requested && requested > 0
        ? Math.min(requested, MAX_USER_CONCURRENCY)
        : Math.min(ceiling, AUTO_CONCURRENCY_CAP);
    const value = Math.max(1, Math.min(wanted, ceiling, chunkCount));
    return { value, capped: wanted > ceiling, ceiling };
}

/**
 * Política de reintentos y fallback.
 *  - MAX_RETRIES_PER_MODEL: intentos contra el MISMO modelo antes de bajar al siguiente.
 *  - MAX_CHAIN_PASSES: veces que se recorre la cadena entera. Si toda la cadena
 *    está saturada ("high demand"), se espera y se da una segunda pasada en
 *    lugar de fallar — los modelos con cuota DIARIA agotada se saltan.
 *  - CHAIN_RETRY_DELAY_MS: espera entre pasadas de la cadena.
 */
export const MAX_RETRIES_PER_MODEL = 3;
/** Intentos de subida de un mismo audio antes de darlo por perdido. */
const MAX_UPLOAD_ATTEMPTS = 2;
export const MAX_CHAIN_PASSES = 2;
const CHAIN_RETRY_DELAY_MS = 15_000;

/** Tope de espera para un único backoff. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Códigos HTTP que significan "el modelo está saturado / fallo transitorio".
 * Son reintentables y, si persisten, deben provocar fallback al siguiente modelo.
 */
const OVERLOAD_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Duración de cada fragmento, en minutos, y umbral para trocear.
 *
 * Bajó de 20 a 10 minutos. Un fragmento es una tirada del modelo sin red: a los
 * 20 minutos la transcripción se degrada por el final (salta trozos, se
 * enrolla en bucles, se queda sin tokens) y un fallo se lleva por delante 20
 * minutos de audio. Con 10 minutos hay el doble de peticiones —irrelevante con
 * 500 RPD y 15 RPM—, el doble de resolución en la barra de progreso, y lo que
 * se pierde cuando algo sale mal es la mitad.
 */
export const CHUNK_SIZE_MINUTES = 10;
export const DURATION_THRESHOLD_CHUNKING = CHUNK_SIZE_MINUTES;
/** Solape entre fragmentos: suficiente para coser la frase partida sin duplicar. */
export const CHUNK_OVERLAP_SECONDS = 15;

/**
 * `08:31` en vez de `[08:31]`, para los AVISOS.
 *
 * Los avisos ("falta el audio de X a Y") se mezclan con la transcripción, y lo
 * que cose los fragmentos busca marcas de tiempo entre corchetes. Un aviso con
 * corchetes se leía como si fuera texto transcrito en ese minuto y se colaba en
 * la costura con el tiempo cambiado.
 */
const plainLabel = (seconds: number) => secondsToLabel(seconds).slice(1, -1);

/** Una marca `[MM:SS]` / `[HH:MM:SS]` y el texto que va detrás. */
interface Segment {
    /** Segundos desde el inicio del audio COMPLETO. */
    at: number;
    body: string;
}

/** Trocea una transcripción por sus marcas de tiempo. Sin marcas, sin segmentos. */
function segmentsOf(text: string): Segment[] {
    const re = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
    const segments: Segment[] = [];
    let open: { at: number; from: number } | null = null;
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
        const [, a, b, c] = match;
        const at = c !== undefined
            ? Number(a) * 3600 + Number(b) * 60 + Number(c)
            : Number(a) * 60 + Number(b);
        if (open) segments.push({ at: open.at, body: text.slice(open.from, match.index).trim() });
        open = { at, from: match.index + match[0].length };
    }
    if (open) segments.push({ at: open.at, body: text.slice(open.from).trim() });

    return segments;
}

/**
 * Cose los fragmentos en una única transcripción con tiempos absolutos.
 *
 * Cada fragmento se transcribe con sus tiempos contados desde sí mismo, y los
 * fragmentos se solapan `CHUNK_OVERLAP_SECONDS` para no partir una frase por la
 * mitad. Las dos cosas se arreglan con el mismo dato, que FFmpeg ya nos da
 * exacto: el segundo real en que empieza cada fragmento. Se le suma a cada
 * marca, y del fragmento siguiente se descarta lo que cae antes de donde llegó
 * el anterior.
 *
 * Antes esto se decidía comparando el TEXTO de los últimos segmentos con el de
 * los primeros y dando por duplicado lo que pasara del 85% de parecido. El
 * solape lo transcribe el modelo dos veces, en dos peticiones distintas, así
 * que casi nunca salía con las mismas palabras: no se reconocía, y el texto
 * final repetía quince segundos en cada costura. El tiempo no tiene esa duda.
 */
export function stitchChunks(chunks: { text: string; startSec: number; endSec: number }[]): string {
    const out: string[] = [];
    /** Segundo del audio hasta el que ya hay texto escrito. */
    let coveredUntil = -Infinity;

    for (const chunk of chunks) {
        const segments = segmentsOf(chunk.text);

        // Sin marcas de tiempo no hay nada que cortar: es el aviso de un
        // fragmento que falló, y va tal cual para que el hueco se vea.
        if (segments.length === 0) {
            if (chunk.text.trim()) out.push(chunk.text.trim());
            continue;
        }

        const kept = segments
            .map((s) => ({ at: s.at + chunk.startSec, body: s.body }))
            .filter((s) => s.body && s.at >= coveredUntil);

        if (kept.length === 0) continue;

        coveredUntil = Math.max(coveredUntil, chunk.endSec);
        out.push(kept.map((s) => `${secondsToLabel(s.at)} ${s.body}`).join('\n'));
    }

    return out.join('\n\n');
}

/**
 * Helper central para llamadas a Gemini con fallback automático de modelos.
 *
 * Lógica de reintentos:
 *  - 429 TPM/RPM (temporal): espera exponencial con jitter, reintenta el MISMO modelo (hasta 3 veces)
 *  - 429 RPD (cuota diaria agotada) o >3 reintentos: pasa al SIGUIENTE modelo de la cadena
 *  - Cualquier otro error HTTP: lanza inmediatamente
 */

/**
 * Marca un error como definitivo: no se reintenta, no se cambia de modelo y,
 * sobre todo, no se le propone al usuario gastar la cuota del Pro por él. Una
 * API Key inválida falla igual en todos los modelos del catálogo.
 */
function definitive<E extends Error>(err: E): E {
    (err as any).definitive = true;
    return err;
}

export function isDefinitiveError(e: unknown): boolean {
    return (e as any)?.definitive === true;
}

/** Backoff exponencial con jitter para el intento n (0-indexado). */
const backoffMs = (attempt: number) => Math.min(Math.pow(2, attempt + 1) * 1000 + Math.random() * 1500, MAX_BACKOFF_MS);

/**
 * Extraer el retryDelay que devuelve la API en los errores 429 (RetryInfo).
 * Es mucho más fiable que un backoff a ciegas.
 */
/**
 * Plazos de red. Generosos —transcribir un fragmento lleva minutos— pero
 * finitos: sin ellos, una conexión que el servidor abandona en silencio deja el
 * proceso esperando para siempre.
 */
const TIMEOUT_GENERATE_MS = 600_000;   // 10 min: transcripción u organización
const TIMEOUT_UPLOAD_START_MS = 60_000;
const TIMEOUT_UPLOAD_STATUS_MS = 30_000;
function parseRetryDelayMs(err: any): number | null {
    const details = err?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details) {
        const raw = d?.retryDelay;
        if (typeof raw === 'string') {
            const m = raw.match(/^([\d.]+)s$/);
            if (m) return Math.ceil(parseFloat(m[1]) * 1000);
        }
    }
    return null;
}

/**
 * ¿El 429 es por cuota DIARIA (RPD) agotada?
 * Si lo es, esperar no sirve de nada: hay que saltar al siguiente modelo.
 * Se mira el quotaId/quotaMetric de QuotaFailure (p. ej.
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier") y sólo como último
 * recurso el texto del mensaje. Importante NO tratar los límites por minuto
 * como diarios: quemaría la cadena de modelos en segundos.
 */
function isDailyQuotaError(err: any): boolean {
    const details = err?.error?.details;
    if (Array.isArray(details)) {
        for (const d of details) {
            const violations = d?.violations;
            if (!Array.isArray(violations)) continue;
            for (const v of violations) {
                const id = `${v?.quotaId || ''} ${v?.quotaMetric || ''}`.toLowerCase();
                if (id.includes('perday') || id.includes('per_day')) return true;
            }
        }
    }
    const msg = (err?.error?.message || '').toLowerCase();
    return msg.includes('per day') || msg.includes('perday') || msg.includes('daily limit');
}

/**
 * Lectura de la respuesta de `streamGenerateContent`.
 *
 * Gemini devuelve SSE: una línea `data:` por trozo generado. Leerlo a trozos
 * en vez de esperar al final es lo que permite que la barra avance DENTRO de
 * una petición; sin esto, un fragmento de diez minutos pasaba de 0 a 100 de
 * golpe tras minuto y medio de pantalla congelada.
 *
 * Acepta también una respuesta JSON entera (`generateContent` clásico): así el
 * mismo lector sirve si alguna vez hay que volver al endpoint no-streaming.
 */
async function readGeminiStream(
    response: Response,
    label: string,
    /** Devolver `false` corta la lectura: el resto de la respuesta no sirve. */
    onDelta?: (accumulated: string) => boolean | void,
): Promise<{ text: string; finishReason: string | null; tokensUsed: number }> {
    let text = '';
    let finishReason: string | null = null;
    let tokensUsed = 0;

    /** Vuelca un objeto de respuesta en el acumulado. */
    const absorb = (parsed: any) => {
        const candidate = parsed?.candidates?.[0];
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) {
            for (const part of parts) {
                if (typeof part?.text === 'string') text += part.text;
            }
        }
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        const count = parsed?.usageMetadata?.candidatesTokenCount;
        if (typeof count === 'number' && count > tokensUsed) tokensUsed = count;
    };

    const { raw, sawSSE, trailing } = await forEachSSE(response, label, (parsed) => {
        absorb(parsed);
        return onDelta?.(text);
    });

    if (sawSSE) {
        // Una última línea `data:` sin salto de línea final.
        if (trailing.startsWith('data:')) {
            const payload = trailing.slice(5).trim();
            if (payload && payload !== '[DONE]') {
                try { absorb(JSON.parse(payload)); onDelta?.(text); } catch { /* incompleta */ }
            }
        }
    } else if (raw.trim()) {
        // No era SSE: un único JSON (o un array de ellos, que es lo que
        // devuelve streamGenerateContent sin `alt=sse`).
        try {
            const parsed = JSON.parse(raw.trim());
            for (const piece of Array.isArray(parsed) ? parsed : [parsed]) absorb(piece);
            onDelta?.(text);
        } catch {
            throw new Error(`${label} devolvió una respuesta ilegible`);
        }
    }

    return { text, finishReason, tokensUsed };
}

/**
 * Salud compartida de los modelos (cuarentena por saturación).
 *
 * Sin esto, una caída de Google se convertía en una tormenta nuestra. Medido
 * en una caída real de `3.5-flash-lite`: siete fragmentos en marcha, seis a la
 * vez, y CADA UNO descubriendo por su cuenta que el modelo estaba caído —tres
 * intentos, cambio de modelo, otros tres— hasta ~70 peticiones contra un
 * servicio que devolvía 503 a todas. El `sharedModelIndex` no llegaba a
 * tiempo: sólo ayuda a los fragmentos que EMPIEZAN más tarde, y con seis en
 * paralelo todos habían empezado ya.
 *
 * Aquí, el primero que se estrella deja el modelo en cuarentena y los demás lo
 * saltan sin gastar ni una petición. Si toda la cadena está en cuarentena, los
 * trabajadores esperan JUNTOS a que expire la más cercana, en vez de cada uno
 * por su lado.
 */
const OVERLOAD_COOLDOWN_STEPS_MS = [5_000, 20_000, 45_000, 90_000];
/** Esperas encadenadas a que se despeje la cadena entera antes de rendirse. */
const MAX_COOLDOWN_WAITS = 3;

const modelHealth = new Map<string, { until: number; strikes: number }>();

/** Milisegundos que le quedan a un modelo en cuarentena (0 si está sano). */
export function modelCooldownMs(model: string, now = Date.now()): number {
    const h = modelHealth.get(model);
    if (!h) return 0;
    return Math.max(0, h.until - now);
}

/**
 * Aparta un modelo un rato. Cada RONDA fallida lo aparta más tiempo.
 *
 * El primer 503 basta para apartarlo: si el servicio está caído, la respuesta
 * correcta es dejar de mandarle cosas, no confirmarlo veinte veces. El primer
 * apartado es corto (5 s) porque un 503 suelto también puede ser un hipo.
 *
 * Los fallos que llegan MIENTRAS ya está apartado no suben el castigo: son la
 * misma tanda de peticiones que salió antes de la cuarentena, no una recaída.
 * Sin esta distinción, seis fragmentos en paralelo saltaban de 5 s a 90 s de
 * golpe por un único bache.
 */
export function coolDownModel(model: string): number {
    const now = Date.now();
    const prev = modelHealth.get(model);
    const remaining = prev ? prev.until - now : 0;
    if (remaining > 0) return remaining;

    const strikes = Math.min((prev?.strikes ?? 0) + 1, OVERLOAD_COOLDOWN_STEPS_MS.length);
    const ms = OVERLOAD_COOLDOWN_STEPS_MS[strikes - 1];
    modelHealth.set(model, { until: now + ms, strikes });
    return ms;
}

/** Una respuesta buena borra el historial: la caída pasó. */
function markModelHealthy(model: string): void {
    modelHealth.delete(model);
}

/**
 * ¿Se ha renunciado al streaming en esta ejecución?
 *
 * Pedir la respuesta en streaming y pedirla entera son dos rutas distintas
 * dentro de Google, y pueden estar una bien y la otra saturada. Cuando el
 * streaming falla y la petición equivalente sin streaming funciona, seguir
 * insistiendo en la primera es tirar el audio a la basura por una barra de
 * progreso más fina.
 */
let streamingDisabled = false;

/** Empieza de cero. La llama cada ejecución nueva y las pruebas. */
export function resetModelHealth(): void {
    modelHealth.clear();
    streamingDisabled = false;
}

const generateUrl = (model: string, apiKey: string, stream: boolean) => stream
    ? `${GEMINI_API_URL}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    : `${GEMINI_API_URL}/models/${model}:generateContent?key=${apiKey}`;

interface GenerateOptions {
    /** Modelo que pidió el usuario: se avisa una sola vez si hay que abandonarlo. */
    preferredModel?: string;
    /** Texto acumulado según llega. Devolver `false` corta la respuesta. */
    onDelta?: (accumulated: string) => boolean | void;
    /** Se llama al empezar cada intento: sirve para contar peticiones reales. */
    onAttempt?: (model: string, attempt: number) => void;
}

interface GenerateResult {
    text: string;
    finishReason: string | null;
    tokensUsed: number;
    modelUsed: string;
    modelIndex: number;
}

/**
 * Repite la petición sin streaming, una sola vez.
 *
 * Devuelve el resultado si la ruta clásica sí funciona (y deja apagado el
 * streaming para lo que queda de ejecución), o `null` si también falla — que
 * es la señal de que el problema es el modelo y no la ruta.
 */
async function tryWithoutStreaming(
    model: string,
    apiKey: string,
    buildBody: (model: string) => object,
    label: string,
    onDelta?: (accumulated: string) => boolean | void,
): Promise<{ text: string; finishReason: string | null; tokensUsed: number } | null> {
    try {
        const res = await fetchWithTimeout(
            generateUrl(model, apiKey, false),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildBody(model)),
            },
            { timeoutMs: TIMEOUT_GENERATE_MS, label: `El modelo ${model}` },
        );
        if (!res.ok) return null;

        const out = await readGeminiStream(res, `El modelo ${model}`, onDelta);
        if (!out.text) return null;

        streamingDisabled = true;
        console.warn(`[${label}] ↩️  El streaming da 503 pero la petición normal responde: se desactiva el streaming`);
        progress.pushEvent('warn', m(
            'La conexión en directo con Gemini falla: se pide la respuesta entera (el avance se verá a saltos)',
            'The live connection to Gemini is failing: asking for the whole response instead (progress will jump)',
        ));
        return out;
    } catch (e: any) {
        if (isCancelledError(e)) throw e;
        return null;
    }
}

async function geminiGenerateWithFallback(
    models: readonly string[],
    apiKey: string,
    buildBody: (model: string) => object,  // body builder — recibe el modelo activo y retorna el body completo
    label: string = 'Gemini',
    startModelIndex: number = 0,
    options: GenerateOptions = {}
): Promise<GenerateResult> {
    const { preferredModel, onDelta, onAttempt } = options;
    /** Aviso, una sola vez, de que se abandona el modelo que pidió el usuario. */
    let warnedAboutPreferred = false;
    const announceSwitch = (from: string, to: string, reason: string) => {
        if (!preferredModel || from !== preferredModel || warnedAboutPreferred) return;
        warnedAboutPreferred = true;
        progress.pushEvent('warn', m(
            `${from} sigue fallando (${reason}); se continúa con ${to}`,
            `${from} keeps failing (${reason}); continuing with ${to}`,
        ));
    };
    // Modelos con cuota DIARIA agotada: no tiene sentido volver a intentarlos hoy.
    const dailyExhausted = new Set<string>();
    let lastError: Error | null = null;
    let sawOverload = false;
    const maxPasses = MAX_CHAIN_PASSES;

    let cooldownWaits = 0;

    for (let pass = 0; pass < maxPasses; pass++) {
        /** ¿Se ha llegado a mandar algo en esta pasada? */
        let triedSomething = false;
        /** Cuánto falta para que se despierte el primer modelo en cuarentena. */
        let soonestCooldown = Infinity;

        for (let mi = startModelIndex; mi < models.length; mi++) {
            const model = models[mi];
            if (dailyExhausted.has(model)) continue;

            // Otro fragmento ya se estrelló contra este modelo hace nada: no
            // se repite el experimento, se pasa al siguiente.
            const cooling = modelCooldownMs(model);
            if (cooling > 0) {
                soonestCooldown = Math.min(soonestCooldown, cooling);
                console.log(`[${label}] 🧊 ${model} en cuarentena (${Math.round(cooling / 1000)}s) — se salta`);
                continue;
            }
            triedSomething = true;

            for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
                throwIfCancelled();
                // Mientras esperábamos, otro fragmento puede haber apartado
                // este modelo. Insistir sería mandar una petición que ya
                // sabemos que va a fallar.
                if (attempt > 0 && modelCooldownMs(model) > 0) {
                    soonestCooldown = Math.min(soonestCooldown, modelCooldownMs(model));
                    // Abandonar el modelo que el usuario eligió se avisa aquí
                    // también: la cuarentena es otra forma de abandonarlo, y
                    // callárselo sería justo lo contrario de lo que pidió.
                    const next = models.slice(mi + 1).find((x) => !dailyExhausted.has(x) && modelCooldownMs(x) === 0);
                    if (next) announceSwitch(model, next, m('saturado', 'overloaded'));
                    break;
                }
                const isLastAttempt = attempt >= MAX_RETRIES_PER_MODEL - 1;
                let response: Response;

                // --- Fallo de red (sin respuesta HTTP) → reintentable ---
                try {
                    onAttempt?.(model, attempt + 1);
                    response = await fetchWithTimeout(
                        generateUrl(model, apiKey, !streamingDisabled),
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(buildBody(model)),
                        },
                        { timeoutMs: TIMEOUT_GENERATE_MS, label: `El modelo ${model}` }
                    );
                } catch (e: any) {
                    if (isCancelledError(e)) throw e;
                    lastError = new Error(`Fallo de red: ${e?.message || e}`);
                    progress.pushEvent('warn', `Fallo de red en ${model}: ${e?.message || e}`);
                    if (isLastAttempt) {
                        coolDownModel(model);
                        const siguiente = models.slice(mi + 1).find((x) => !dailyExhausted.has(x));
                        if (siguiente) announceSwitch(model, siguiente, m('fallo de red', 'network failure'));
                        console.warn(`[${label}] ⚠️  ${model}: network failures → next model`);
                        break;
                    }
                    await sleep(backoffMs(attempt));
                    continue;
                }

                if (response.ok) {
                    if (mi > startModelIndex || pass > 0) {
                        console.log(`[${label}] ✅ Success with fallback model: ${model}`);
                    }
                    // Un stream que se corta a media respuesta es un fallo de
                    // red como cualquier otro: se reintenta en vez de devolver
                    // media transcripción como si estuviera entera.
                    try {
                        const out = await readGeminiStream(response, `El modelo ${model}`, onDelta);
                        markModelHealthy(model);
                        return { ...out, modelUsed: model, modelIndex: mi };
                    } catch (e: any) {
                        if (isCancelledError(e)) throw e;
                        lastError = new Error(`Stream interrumpido: ${e?.message || e}`);
                        progress.pushEvent('warn', `Respuesta interrumpida en ${model}: ${e?.message || e}`);
                        if (isLastAttempt) break;
                        await sleep(backoffMs(attempt));
                        continue;
                    }
                }

                const err = await response.json().catch(() => ({}));
                const apiMessage = err?.error?.message || `Error (${response.status})`;
                lastError = new Error(apiMessage);

                // --- Cuota diaria (RPD) agotada → esperar no sirve, saltar modelo ---
                if (response.status === 429 && isDailyQuotaError(err)) {
                    progress.pushEvent('warn', `Cuota diaria (RPD) agotada en ${model}`);
                    dailyExhausted.add(model);
                    const next = models.slice(mi + 1).find(x => !dailyExhausted.has(x));
                    if (next) announceSwitch(model, next, m('cuota diaria agotada', 'daily quota exhausted'));
                    console.warn(`[${label}] ⚠️  ${model}: daily quota (RPD) exhausted → ${next ? `switching to ${next}` : 'no models left'}`);
                    break;
                }

                const overloaded = OVERLOAD_STATUSES.has(response.status);
                const rateLimited = response.status === 429;

                // --- Error real (400 body inválido, 403 key mala, 404 modelo inexistente…) ---
                // Se marca como definitivo: cambiar de modelo, esperar o subir
                // a uno más potente no arregla una API Key mala.
                if (!overloaded && !rateLimited) {
                    throw definitive(new Error(apiMessage));
                }

                if (overloaded) {
                    sawOverload = true;
                    // Basta un 503 para apartarlo: los demás fragmentos no
                    // tienen por qué volver a comprobar que sigue caído.
                    //
                    // Sólo la saturación (5xx) aparta al modelo. Un 429 NO: ahí
                    // el modelo está perfectamente y el que va rápido somos
                    // nosotros, así que lo que toca es esperar el `retryDelay`
                    // que manda la propia API y volver — apartarlo tiraba a la
                    // basura el reintento que sí habría funcionado.
                    const alreadyCooling = modelCooldownMs(model) > 0;
                    coolDownModel(model);

                    // ¿Es el modelo el que está saturado, o sólo la ruta de
                    // streaming? Se comprueba en vez de suponerlo: una sola
                    // petición equivalente sin streaming lo dice. Si esa sí
                    // responde, el resto de la ejecución va por ahí.
                    //
                    // La sonda va DESPUÉS de apartar el modelo, y sólo la paga
                    // quien lo aparta. Antes iba delante y sin condición: con
                    // seis fragmentos en paralelo contra un modelo caído, los
                    // seis se comían su 503 y los seis sondeaban — el número de
                    // peticiones contra un servicio ya caído se duplicaba, que
                    // es justo la tormenta que la cuarentena existe para evitar.
                    if (!alreadyCooling && !streamingDisabled) {
                        const probe = await tryWithoutStreaming(model, apiKey, buildBody, label, onDelta);
                        if (probe) {
                            markModelHealthy(model);
                            return { ...probe, modelUsed: model, modelIndex: mi };
                        }
                    }
                }

                // --- Agotados los reintentos de este modelo → siguiente de la cadena ---
                if (isLastAttempt) {
                    const reason = overloaded ? 'overloaded (high demand)' : 'rate limited';
                    console.warn(`[${label}] 🧊 ${model} apartado ${Math.round(modelCooldownMs(model) / 1000)}s`);
                    const next = models.slice(mi + 1).find(x => !dailyExhausted.has(x));
                    if (next) announceSwitch(model, next, overloaded ? m('saturado', 'overloaded') : m('límite de peticiones', 'rate limited'));
                    if (next) {
                        console.warn(`[${label}] ⚠️  ${model}: ${reason} after ${MAX_RETRIES_PER_MODEL} attempts → switching to ${next}`);
                    } else {
                        console.error(`[${label}] ❌ ${model}: ${reason} — end of chain (pass ${pass + 1}/${maxPasses})`);
                    }
                    break;
                }

                // --- Reintentar el mismo modelo: retryDelay de la API si viene, si no backoff ---
                const suggested = parseRetryDelayMs(err);
                const waitMs = Math.min(suggested ?? backoffMs(attempt), MAX_BACKOFF_MS);
                const what = overloaded ? `Overloaded (${response.status})` : 'Rate limited';
                progress.pushEvent('retry', `${what} en ${model} — esperando ${(waitMs / 1000).toFixed(0)}s`);
                progress.beginWait(Date.now() + waitMs, `${what} en ${model}`);
                console.log(`[${label}] ⏳ ${what} on ${model} (attempt ${attempt + 1}/${MAX_RETRIES_PER_MODEL}), waiting ${(waitMs / 1000).toFixed(1)}s${suggested ? ' (API retryDelay)' : ''}...`);
                await sleep(waitMs);
                progress.endWait();
            }
        }

        // Fin de una pasada completa por la cadena.
        const remaining = models.slice(startModelIndex).filter(m => !dailyExhausted.has(m));
        if (remaining.length === 0) break;           // todo agotado por cuota diaria: no insistir

        // Toda la cadena en cuarentena: se espera UNA vez, y todos los
        // fragmentos que estén en las mismas convergen en la misma espera en
        // lugar de aporrear el servicio cada uno por su cuenta.
        if (!triedSomething && Number.isFinite(soonestCooldown)) {
            if (++cooldownWaits > MAX_COOLDOWN_WAITS) break;
            const waitMs = Math.min(soonestCooldown + 500, MAX_BACKOFF_MS);
            console.warn(`[${label}] 🧊 Toda la cadena en cuarentena — esperando ${(waitMs / 1000).toFixed(0)}s`);
            progress.beginWait(Date.now() + waitMs, m(
                'El servicio de Google está saturado',
                'Google’s service is overloaded',
            ));
            await sleep(waitMs);
            progress.endWait();
            pass--;   // esperar no consume una pasada: no se ha probado nada
            continue;
        }

        if (pass < maxPasses - 1) {
            const waitMs = CHAIN_RETRY_DELAY_MS + Math.random() * 5000;
            console.warn(`[${label}] 🔁 Whole chain busy — waiting ${(waitMs / 1000).toFixed(0)}s and retrying (pass ${pass + 2}/${maxPasses})`);
            await sleep(waitMs);
        }
    }

    const allDaily = models.slice(startModelIndex).every(m => dailyExhausted.has(m));
    if (allDaily) {
        throw new Error('Todos los modelos de Gemini agotaron su cuota diaria (RPD). Inténtalo mañana o usa otra API Key.');
    }
    if (sawOverload) {
        throw new Error(`Todos los modelos de Gemini están saturados ahora mismo. Inténtalo en unos minutos. (${lastError?.message || 'model overloaded'})`);
    }
    throw new Error(`Todos los modelos de Gemini alcanzaron su límite de cuota. Intenta en unos minutos.${lastError ? ` (${lastError.message})` : ''}`);
}

/**
 * Subir archivo a Gemini Files API
 */
async function uploadToGemini(file: File, apiKey: string, onProgress?: (p: number) => void): Promise<string> {
    onProgress?.(0.1);

    // Normalizar MIME type para el upload también
    let mimeType = file.type || 'audio/mpeg';
    if (mimeType === 'audio/x-m4a') mimeType = 'audio/mp4';
    if (mimeType === 'audio/x-wav') mimeType = 'audio/wav';

    // Paso 1: Iniciar upload resumable
    const startRes = await fetchWithTimeout(`${GEMINI_UPLOAD_URL}/files?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(file.size),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            file: { displayName: file.name },
        }),
    }, { timeoutMs: TIMEOUT_UPLOAD_START_MS, label: 'Gemini (inicio de subida)' });

    if (!startRes.ok) {
        const err = await startRes.text();
        throw new Error(`Error al iniciar upload: ${err}`);
    }

    const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('No se pudo obtener URL de upload');

    onProgress?.(0.2);

    // Paso 2: Subir bytes
    // El plazo escala con el tamaño: subir 40 MB por una conexión lenta es
    // legítimo, quedarse parado en el byte 3 durante media hora no.
    const uploadTimeoutMs = Math.min(30 * 60_000, 120_000 + (file.size / (1024 * 1024)) * 20_000);
    const uploadRes = await fetchWithTimeout(uploadUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
            'Content-Length': String(file.size),
        },
        body: file,
    }, { timeoutMs: uploadTimeoutMs, label: 'Gemini (subida del audio)' });

    if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(`Error al subir archivo: ${err}`);
    }

    const uploadData = await uploadRes.json();
    const fileUri = uploadData.file?.uri;
    const fileName = uploadData.file?.name;

    if (!fileUri) throw new Error('No se recibió URI del archivo');

    onProgress?.(0.4);

    // Paso 3: Esperar a que esté ACTIVE
    let attempts = 0;
    console.log(`[Gemini Upload] Waiting for file processing...`);

    while (attempts < 120) {
        throwIfCancelled();
        const statusRes = await fetchWithTimeout(
            `${GEMINI_API_URL}/${fileName}?key=${apiKey}`,
            {},
            { timeoutMs: TIMEOUT_UPLOAD_STATUS_MS, label: 'Gemini (estado del archivo)' },
        );
        const statusData = await statusRes.json().catch(() => ({} as any));

        if (statusData.state === 'ACTIVE') {
            console.log('[Gemini Upload] ✅ File ready');
            onProgress?.(0.5);
            return fileUri;
        }
        if (statusData.state === 'FAILED') {
            throw new Error(`Procesamiento falló: ${statusData.error?.message || 'Error desconocido'}`);
        }

        await new Promise(r => setTimeout(r, 2000));
        attempts++;

        if (attempts % 10 === 0) {
            console.log(`[Gemini Upload] Still waiting... (${attempts}/120)`);
        }

        onProgress?.(0.4 + (attempts / 120) * 0.1);
    }

    throw new Error('Timeout esperando procesamiento (4 minutos)');
}

/**
 * Interfaz para retornar transcripción con metadata de tokens
 */
interface TranscriptionResult {
    text: string;
    tokensUsed: number;
}

/**
 * Progreso dentro de una transcripción, deducido de los timestamps.
 *
 * El modelo va emitiendo `[MM:SS]` conforme avanza por el audio. Ese número es
 * la única medida honesta de "por dónde va": no es una animación ni una
 * estimación, es el minuto de grabación que acaba de transcribir.
 */
function progressFromTimestamps(text: string, durationSeconds: number): number {
    if (!(durationSeconds > 0)) return 0;
    const last = lastTimestampSeconds(text);
    if (last === null) return 0;
    return Math.min(0.98, Math.max(0, last / durationSeconds));
}

/**
 * Instrucciones de transcripción.
 *
 * Se reescribió entero con una idea: cada regla que no impide un fallo
 * observado es ruido que compite con las que sí. Lo que queda ataca lo que de
 * verdad rompía las transcripciones — resumir en vez de transcribir, traducir
 * al idioma del prompt, comentar el audio, atascarse repitiendo una palabra y
 * dejarse la cola del fragmento sin transcribir.
 */
function transcriptionPrompt(chunk?: { index: number; total: number; startSec: number; endSec: number }): string {
    const dur = chunk ? Math.round((chunk.endSec - chunk.startSec) / 60) : 0;

    const context = chunk
        ? `This audio is part ${chunk.index + 1} of ${chunk.total} of a longer recording (~${dur} min of audio).
It starts mid-conversation and may end mid-sentence. That is expected: transcribe exactly what you hear, from the very first word to the very last one. Do not add an intro or a conclusion.
Timestamps must be relative to THIS audio: the first word is [00:00].`
        : 'Transcribe the whole recording, from the first word to the last one.';

    return `Transcribe this audio verbatim, in its original spoken language.

${context}

RULES
1. Verbatim: every sentence that is spoken, word for word. Never summarize, shorten, paraphrase or skip a passage.
2. Never translate. Write in the language being spoken.
3. Only the transcript. No preamble, no commentary, no notes about the audio quality, no "[music]" style labels.
4. Timestamp \`[MM:SS]\` at the start of a line roughly every 30 seconds, and whenever the topic changes. Never mid-sentence. Always in ascending order.
5. Unintelligible speech: write [inaudible]. Never invent words to fill a gap.
6. If a word or phrase repeats in the audio, transcribe it once and move on. Never emit the same short phrase more than twice in a row.
7. Keep going until the audio ends. Do not stop early.

FORMAT
[00:00] First spoken sentence here.
[00:31] Next sentences here, continuing naturally.

Begin the transcript now.`;
}

/** Metadatos opcionales del fragmento al que pertenece esta llamada. */
export interface ChunkContext {
    index: number;
    total: number;
    startSec: number;
    endSec: number;
    /** Avance 0-1 dentro del fragmento, en tiempo real. */
    onProgress?: (p: number) => void;
}

/**
 * 🎵 Transcribe un audio (completo si es corto, o un fragmento de uno largo).
 * Sube el archivo, lo transcribe en streaming y va publicando por dónde va.
 */
export async function transcribeWithGemini(
    file: File,
    apiKey: string,
    onProgress?: (progress: number) => void,
    duration?: number,
    startModelIndex: number = 0,
    model?: string,
    chunk?: ChunkContext,
): Promise<TranscriptionResult & { modelIndex: number; modelUsed: string; requests: number }> {
    if (!apiKey) throw new Error('Gemini API Key no configurada');

    // Validar duración
    let durationSeconds = duration || 0;

    if (durationSeconds === 0) {
        console.warn('[Gemini] ⚠️  Duration not provided - estimating');
        const estimatedMinutes = file.size / (1024 * 1024);
        durationSeconds = estimatedMinutes * 60;
    }

    const minutes = durationSeconds / 60;
    const tag = chunk ? `Gemini Chunk ${chunk.index + 1}` : 'Gemini Transcribe';

    console.log(`[${tag}] 🎵 ${(file.size / 1024 / 1024).toFixed(1)}MB · ${minutes.toFixed(1)} min`);

    const startTime = Date.now();

    // Upload, con un segundo intento.
    //
    // La subida iba a pelo: un corte de red de un segundo en mitad de los 20 MB
    // de un fragmento lo daba por perdido y dejaba un hueco en la transcripción
    // que un simple reintento habría evitado.
    let fileUri = '';
    for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
        throwIfCancelled();
        try {
            fileUri = await uploadToGemini(file, apiKey, (p) => {
                onProgress?.(p * 0.5);
                // Dentro de un fragmento, la subida es el primer 15% del trabajo.
                chunk?.onProgress?.(p * 0.3);
            });
            break;
        } catch (e: any) {
            if (isCancelledError(e)) throw e;
            if (attempt >= MAX_UPLOAD_ATTEMPTS - 1) throw e;
            const waitMs = backoffMs(attempt);
            console.warn(`[${tag}] ⚠️  Subida fallida (${e?.message || e}); reintento en ${(waitMs / 1000).toFixed(0)}s`);
            progress.pushEvent('retry', m(
                `Falló la subida del audio — reintentando en ${Math.round(waitMs / 1000)}s`,
                `Audio upload failed — retrying in ${Math.round(waitMs / 1000)}s`,
            ), { chunk: chunk?.index });
            progress.beginWait(Date.now() + waitMs, m('Reintentando la subida', 'Retrying the upload'));
            await sleep(waitMs);
            progress.endWait();
        }
    }
    onProgress?.(0.5);
    chunk?.onProgress?.(0.15);

    // Normalizar MIME type (Gemini puede rechazar audio/x-m4a)
    let mimeType = file.type || 'audio/mpeg';
    if (mimeType === 'audio/x-m4a') mimeType = 'audio/mp4';
    if (mimeType === 'audio/x-wav') mimeType = 'audio/wav';

    const isFixed = Boolean(model && model !== 'auto');
    const models = chainStartingWith(model, TRANSCRIPTION_FALLBACK_MODELS);
    // Con modelo elegido siempre se arranca por él; el índice compartido sólo
    // tiene sentido cuando la cadena es la de siempre.
    const startIdx = isFixed ? 0 : startModelIndex;
    const maxTokens = outputTokenBudget(durationSeconds, TRANSCRIPTION_MAX_OUTPUT_TOKENS);
    const prompt = transcriptionPrompt(chunk);

    let requests = 0;
    /** Próxima longitud a la que toca comprobar si el modelo se ha atascado. */
    let loopCheckAt = 3000;

    // Transcribir con fallback automático de modelos, publicando el avance
    // según llega el texto.
    const { text, finishReason, tokensUsed, modelUsed, modelIndex } = await geminiGenerateWithFallback(
        models,
        apiKey,
        (_model) => ({
            contents: [{
                parts: [
                    { fileData: { mimeType: mimeType, fileUri } },
                    { text: prompt }
                ]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: maxTokens,
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            ],
        }),
        tag,
        startIdx,
        {
            preferredModel: isFixed ? model : undefined,
            onAttempt: (activeModel, attempt) => {
                requests++;
                if (chunk) {
                    progress.setChunkMeta(chunk.index, { model: activeModel, attempts: attempt, requests });
                } else {
                    progress.setModel(activeModel, { n: attempt, max: MAX_RETRIES_PER_MODEL });
                }
            },
            onDelta: (acc) => {
                const p = progressFromTimestamps(acc, durationSeconds);
                // El texto que llega es el 85% restante del trabajo del fragmento.
                chunk?.onProgress?.(0.15 + p * 0.85);
                onProgress?.(0.5 + p * 0.45);
                if (!chunk) progress.setStreamCounters(acc.length);

                // Un modelo atascado ("no, no, no…") no se desatasca solo: se
                // queda repitiendo hasta agotar el presupuesto de tokens. Antes
                // había que pagar la respuesta entera y limpiarla después;
                // ahora se corta en cuanto se ve, y lo transcrito hasta ahí se
                // conserva.
                if (acc.length >= loopCheckAt) {
                    loopCheckAt = acc.length + 3000;
                    if (tailRepetitionRun(acc)) {
                        console.warn(`[${tag}] 🔁 Repetition loop detected — cutting the stream`);
                        progress.pushEvent('warn', m(
                            'El modelo se atascó repitiendo — se corta ahí',
                            'The model got stuck repeating — cutting it short',
                        ), { chunk: chunk?.index });
                        return false;
                    }
                }
            },
        },
    );

    onProgress?.(0.95);

    if (!text) {
        console.error(`[${tag}] Finish Reason:`, finishReason);
        throw new Error(`No se generó transcripción. Razón: ${finishReason || 'Desconocida'}`);
    }

    // Limpiar espacios dentro de los timestamps: [ 00:13:19] -> [00:13:19]
    let cleanText = text.replace(/\[\s+(\d)/g, '[$1');

    const repCheck = stripRepetitionRuns(cleanText);
    if (repCheck.removed > 0) {
        cleanText = repCheck.text;
    }

    // POST-PROCESSING: Limpiar artifacts si llegó a MAX_TOKENS
    if (finishReason === 'MAX_TOKENS') {
        console.warn(`[${tag}] ⚠️  Hit MAX_TOKENS - Cleaning artifacts...`);
        const lastSec = lastTimestampSeconds(cleanText);
        const lastLabel = lastSec !== null ? plainLabel(lastSec) : null;
        cleanText = cleanText.replace(/(\b\w{1,4}\b)(?:\s+\1){5,}$/gi, '');
        cleanText += `\n\n[⚠️ Transcripción cortada por límite de tokens${lastLabel ? `. Falta el audio a partir de ${lastLabel}` : ''}]`;
    }

    const finalText = cleanText;
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`[${tag}] ✅ ${modelUsed} · ${totalTime}s · ${finishReason} · ${tokensUsed} tok · ${finalText.length} chars`);

    onProgress?.(1);
    return { text: finalText, tokensUsed, modelIndex, modelUsed, requests };
}

/**
 * RUTA CHUNKING: transcripción en paralelo para audios largos.
 *
 * Los fragmentos llegan ya cortados POR TIEMPO desde `audio-processor`, que usa
 * FFmpeg. Aquí sólo se reparten entre varios Flash Lite a la vez, sin pasarse
 * del RPM/TPM del free tier, y se cosen al final.
 *
 * Aquí había además un troceado propio que cortaba el archivo por BYTES cuando
 * llegaba entero (`file.slice(offset, end)`). Era el peor fallo del sistema y
 * explicaba la mayoría de los "fragmento X falló": salvo el primero, esos
 * trozos no son archivos de audio. Un WAV sin su cabecera RIFF no es nada, y un
 * MP3 cortado a mitad de trama empieza con basura y sin cabecera de duración.
 * Se le mandaban a Gemini como si fueran audio y Gemini respondía lo que podía:
 * un error, o una transcripción inventada sobre ruido. La ruta de Groq ya había
 * aprendido esto y trocea con FFmpeg; la de Gemini se había quedado atrás.
 */
export async function transcribeWithGeminiChunked(
    file: File | File[],
    apiKey: string,
    onProgress?: (progress: number) => void,
    duration?: number,
    chunkMetadata?: { startTime: number; endTime: number; index: number }[],
    model?: string,
    /** Fragmentos simultáneos que pidió el usuario. 0 o ausente = automático. */
    requestedConcurrency?: number,
): Promise<TranscriptionResult> {
    if (!apiKey) throw new Error('Gemini API Key no configurada');

    // 1. Preparar Chunks
    console.log('[Gemini Chunked] 🧩 Starting parallel chunking');

    const isPreChunked = Array.isArray(file) && Boolean(chunkMetadata);

    // Sin fragmentos por tiempo no hay nada que trocear aquí: el archivo va
    // entero, en una sola petición. Es lo que ya ocurre con un audio corto, y es
    // preferible a inventarse cortes: como mucho la respuesta se corta por
    // límite de tokens, y eso se avisa y se ve.
    const chunks: { blob: Blob | File, start: number, end: number, index: number, fileName: string }[] =
        isPreChunked
            ? (file as File[]).map((f, i) => ({
                blob: f,
                start: chunkMetadata![i].startTime,
                end: chunkMetadata![i].endTime,
                index: i,
                fileName: f.name,
            }))
            : (() => {
                const single = Array.isArray(file) ? file[0] : file;
                console.warn('[Gemini Chunked] ⚠️  Sin fragmentos temporales: se transcribe el audio entero');
                // Merece un aviso: en una sola petición, un audio largo puede
                // no caber en el presupuesto de tokens y quedarse a medias. Se
                // señala igualmente en el texto, pero mejor saberlo antes.
                progress.pushEvent('warn', m(
                    'No se pudo trocear el audio: se transcribe entero y puede quedarse corto',
                    'The audio could not be split: transcribing it whole may cut it short',
                ));
                return [{
                    blob: single,
                    start: 0,
                    end: sanitizeDuration(duration),
                    index: 0,
                    fileName: single.name,
                }];
            })();

    if (isPreChunked) {
        console.log(`[Gemini Chunked] Using ${chunks.length} pre-existing temporal chunks`);
    }

    console.log(`[Gemini Chunked] Ready to transcribe ${chunks.length} chunks`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // La cuarentena es de esta ejecución: una caída de hace una hora no debe
    // condicionar el intento de ahora.
    resetModelHealth();

    progress.initChunks(chunks.map(c => ({ startSec: c.start, endSec: c.end })));

    // 2. Transcribir en Paralelo con índice de modelo compartido
    // Si un chunk descubre que el modelo primario está agotado (RPD),
    // actualiza sharedModelIndex para que los chunks siguientes
    // arranquen directamente desde el modelo que sí funciona.
    let completedChunks = 0;
    let sharedModelIndex = 0; // índice compartido de la cadena TRANSCRIPTION_FALLBACK_MODELS
    const isFixed = Boolean(model && model !== 'auto');
    const activeChain = chainStartingWith(model, TRANSCRIPTION_FALLBACK_MODELS);

    const updateProgress = () => {
        completedChunks++;
        onProgress?.(completedChunks / chunks.length);
    };

    const startTime = Date.now();

    // Cuántos a la vez. Lo elige el usuario, pero nunca por encima de lo que
    // permiten el RPM y el TPM del modelo: pasar de ahí no es ir más rápido,
    // es garantizar 429s y acabar tardando más.
    const avgChunkSeconds = chunks.reduce((sum, c) => sum + (c.end - c.start), 0) / chunks.length;
    const { value: concurrency, capped, ceiling } = resolveConcurrency(
        activeChain[sharedModelIndex] || activeChain[0],
        avgChunkSeconds,
        chunks.length,
        requestedConcurrency,
    );
    if (capped) {
        progress.pushEvent('info', m(
            `Se transcriben ${ceiling} fragmentos a la vez: más no cabe en el límite gratuito`,
            `Transcribing ${ceiling} chunks at a time: more does not fit in the free limit`,
        ));
    }
    progress.pushEvent('info', m(
        `${chunks.length} fragmentos de ${Math.round(avgChunkSeconds / 60)} min · ${concurrency} a la vez`,
        `${chunks.length} chunks of ${Math.round(avgChunkSeconds / 60)} min · ${concurrency} at a time`,
    ));
    console.log(`[Gemini Chunked] Concurrency: ${concurrency}/${chunks.length} (~${Math.round(avgChunkSeconds / 60)} min each)`);

    const transcribeChunk = async (chunk: typeof chunks[number]) => {
        // Normalizar MIME type para el chunk - CRÍTICO para M4A
        const originalType = isPreChunked ? (file as File[])[0].type : (file as File).type;
        const originalName = isPreChunked ? (file as File[])[0].name : (file as File).name;

        let chunkType = chunk.blob.type || originalType;
        if (!chunkType || chunkType === 'audio/x-m4a' || chunkType === '') {
            chunkType = 'audio/mp4';
        }
        if (chunkType === 'audio/x-wav') chunkType = 'audio/wav';

        console.log(`[Gemini Chunked] Chunk ${chunk.index} type: ${chunkType} (Original: ${originalType})`);

        const chunkFile = new File([chunk.blob], `${originalName}_part${chunk.index}`, { type: chunkType });
        const chunkDuration = chunk.end - chunk.start;

        progress.setChunk(chunk.index, 'active');

        try {
            const startIdx = isFixed ? 0 : sharedModelIndex;
            const result = await transcribeWithGemini(
                chunkFile, apiKey, undefined, chunkDuration, startIdx, model,
                {
                    index: chunk.index,
                    total: chunks.length,
                    startSec: chunk.start,
                    endSec: chunk.end,
                    // Lo que mueve la barra: el minuto de audio que el modelo
                    // acaba de transcribir, mientras lo transcribe.
                    onProgress: (p) => progress.setChunk(chunk.index, 'active', p),
                },
            );

            if (!isFixed && result.modelIndex > sharedModelIndex) {
                console.log(`[Gemini Chunked] 🔀 Updating shared model index: ${sharedModelIndex} → ${result.modelIndex}`);
                sharedModelIndex = result.modelIndex;
            }

            progress.setChunkMeta(chunk.index, {
                model: result.modelUsed,
                requests: result.requests,
                tokens: result.tokensUsed,
                error: null,
            });
            progress.setChunk(chunk.index, 'done', 1);
            updateProgress();
            return {
                index: chunk.index,
                text: result.text,
                tokens: result.tokensUsed,
                startSec: chunk.start,
                endSec: chunk.end,
            };
        } catch (e: any) {
            if (isCancelledError(e)) throw e;
            console.error(`[Gemini Chunked] ❌ Chunk ${chunk.index + 1} failed: ${e?.message || e}`);
            progress.setChunkMeta(chunk.index, { error: e?.message || String(e) });
            progress.setChunk(chunk.index, 'error', 0);
            progress.pushEvent('warn', m(
                `Fragmento ${chunk.index + 1}: ${e?.message || 'no se pudo transcribir'}`,
                `Chunk ${chunk.index + 1}: ${e?.message || 'could not be transcribed'}`,
            ), { chunk: chunk.index });
            updateProgress();
            const startLabel = plainLabel(chunk.start);
            const endLabel = plainLabel(chunk.end);
            return {
                index: chunk.index,
                text: `[⚠️ Falta el audio de ${startLabel} a ${endLabel}: ${e?.message || 'Error al transcribir fragmento'}]`,
                tokens: 0,
                startSec: chunk.start,
                endSec: chunk.end,
            };
        }
    };

    // Pool de workers: cada worker va tomando el siguiente chunk pendiente.
    type ChunkResult = Awaited<ReturnType<typeof transcribeChunk>>;
    const results: ChunkResult[] = [];
    let nextChunkIndex = 0;

    const worker = async () => {
        while (true) {
            const i = nextChunkIndex++;
            if (i >= chunks.length) return;
            results.push(await transcribeChunk(chunks[i]));
        }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    const successfulChunks = results.filter(r => !r.text.startsWith('[⚠️ Falta el audio'));
    if (successfulChunks.length === 0 && results.length > 0) {
        const firstError = results[0].text.replace(/^\[⚠️ Falta el audio de [^:]+:\s*/, '').replace(/\]$/, '');
        throw new Error(firstError || 'Todos los fragmentos fallaron al transcribir.');
    }

    // 3. Coser: tiempos absolutos y solape fuera, ambos por el segundo de inicio.
    console.log('[Gemini Chunked] 🔧 Stitching chunks (absolute timestamps + overlap)');

    results.sort((a, b) => a.index - b.index);
    const cleanedText = stitchChunks(results);

    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[Gemini Chunked] ✅ Complete');
    console.log(`[Gemini Chunked] Time: ${totalTime}s | Chunks: ${chunks.length}`);
    console.log(`[Gemini Chunked] Total tokens: ${totalTokens}`);
    console.log(`[Gemini Chunked] Output: ${cleanedText.length} chars`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    onProgress?.(1);
    return { text: cleanedText, tokensUsed: totalTokens };
}

import type { SummaryLevel } from './store';
import { buildNotesPrompt, expectedSections, splitTitle } from './notes-prompt';

// El prompt de los apuntes vive en `notes-prompt.ts`: es el mismo para todos
// los proveedores. Se re-exporta porque aquí lo buscaban las pruebas y la UI.
export { buildNotesPrompt, splitTitle };

/**
 * Redacta los apuntes en UNA petición grande.
 *
 * Reparto de papeles del free tier: los fragmentos los transcriben los Flash
 * Lite (muchas peticiones, 500 al día); aquí, que es una sola petición por
 * audio y la que decide la calidad de lo que se lee, entra un Flash. Y si los
 * Flash se han quedado sin sus 20 peticiones diarias, se cae a un Lite en vez
 * de fallar: la transcripción ya está pagada.
 */
export async function organizeNotesWithGemini(
    transcription: string,
    apiKey: string,
    onStep?: (step: number) => void,
    summaryLevel: SummaryLevel = 'short',
    outputLanguage: string = 'auto'
): Promise<{ notes: string, tokensUsed: number }> {
    if (!apiKey) throw new Error('Gemini API Key missing');
    if (!transcription) throw new Error('Missing transcription to organize');

    onStep?.(1);
    console.log(`[Gemini Organize] 📚 ${transcription.length} chars · nivel ${summaryLevel}`);

    const prompt = buildNotesPrompt(transcription, summaryLevel, outputLanguage);
    const sections = expectedSections(summaryLevel);
    onStep?.(2);

    const startTime = Date.now();

    const body = (model: string) => ({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.2,
            // Usa el máximo real del modelo activo; conservador por defecto.
            maxOutputTokens: ORGANIZATION_MAX_OUTPUT_TOKENS[model] ?? 8192,
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    });

    /**
     * El texto llega en streaming: cada `##` que aparece es una sección
     * terminada, y eso mueve la barra con algo real en vez de con un reloj.
     */
    const onDelta = (acc: string) => {
        const headings = acc.match(/^##\s+.*$/gm) || [];
        const ratio = Math.min(0.97, Math.max(
            headings.length / sections,
            Math.min(0.15, acc.length / 6000),
        ));
        const current = headings.length ? headings[headings.length - 1].replace(/^##\s+/, '') : null;
        progress.setStreamCounters(acc.length);
        progress.setStage('organize', ratio, current
            ? m(`Redactando: ${current}`, `Writing: ${current}`)
            : m('Analizando la transcripción', 'Analyzing the transcript'));
    };

    const call = (models: readonly string[], label: string) => geminiGenerateWithFallback(
        models, apiKey, body, label, 0,
        { onDelta, onAttempt: (model, attempt) => progress.setModel(model, { n: attempt, max: MAX_RETRIES_PER_MODEL }) },
    );

    let result: GenerateResult;
    try {
        result = await call(ORGANIZATION_FALLBACK_MODELS, 'Gemini Organize');
    } catch (e: any) {
        if (isCancelledError(e)) throw e;

        // Un fallo definitivo (key inválida, petición mal formada) falla igual
        // en cualquier modelo: no se reintenta con otro.
        if (isDefinitiveError(e)) throw e;

        // Los cuatro Flash se han quedado sin cuota o sin servicio. Se redacta
        // con un Flash Lite antes que devolver un error con la transcripción
        // ya hecha: unos apuntes algo más flojos valen infinitamente más que
        // media hora de audio transcrita y tirada.
        console.warn('[Gemini Organize] ⚠️  Toda la cadena Flash falló:', e?.message || e);
        progress.pushEvent('warn', m(
            'Los modelos Flash no están disponibles: se redactan los apuntes con Flash Lite',
            'The Flash models are unavailable: writing the notes with Flash Lite instead',
        ));

        result = await call(GEMINI_NOTES_FALLBACK_CHAIN, 'Gemini Organize (Flash Lite)');
    }

    onStep?.(3);

    const { text: content, finishReason, tokensUsed, modelUsed } = result;
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Gemini Organize] ✅ ${modelUsed} · ${totalTime}s · ${finishReason} · ${tokensUsed} tok`);

    if (!content) {
        throw new Error(`No se generaron apuntes. Razón: ${finishReason || 'Desconocida'}`);
    }

    onStep?.(4);
    onStep?.(5);
    const cleaned = stripRepetitionRuns(content).text;
    return { notes: cleaned, tokensUsed };
}

/**
 * Validar Gemini API Key
 */
export async function validateGeminiKey(apiKey: string): Promise<boolean> {
    try {
        const response = await fetch(`${GEMINI_API_URL}/models?key=${apiKey}&pageSize=1`);
        return response.ok;
    } catch (e) {
        console.error('Gemini validation error:', e);
        return false;
    }
}
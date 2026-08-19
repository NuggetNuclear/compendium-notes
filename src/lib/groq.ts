const GROQ_API_URL = 'https://api.groq.com/openai/v1';
import { progress, m as msg } from './progress';
import { forEachSSE } from './sse';
import { stripRepetitionRuns, tailRepetitionRun, lastTimestampLabel, secondsToLabel } from './text-cleanup';
import { transcribeWithLoopRecovery } from './loop-recovery';
import { sleep, fetchWithTimeout, isCancelledError, isTimeoutError, throwIfCancelled } from './pipeline-control';

/**
 * Error de Groq que sabe si tiene arreglo.
 *
 * La diferencia importa: una key inválida o un archivo demasiado grande no
 * mejoran por insistir, mientras que un 429 o un 503 casi siempre sí. Sin esta
 * distinción, o se reintenta lo que nunca va a funcionar, o se tira la toalla
 * ante una saturación de treinta segundos.
 */
class GroqError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
        readonly retryAfterMs = 0,
    ) {
        super(message);
        this.name = 'GroqError';
    }
}

/** Milisegundos que pide esperar la cabecera `retry-after`, si viene. */
function retryAfterMs(response: Response, fallback: number): number {
    const header = Number(response.headers.get('retry-after')) * 1000;
    return isFinite(header) && header > 0 ? Math.min(header, 60_000) : fallback;
}

/**
 * Transcribe a single audio file (must be ≤ 25MB)
 */
async function transcribeSingleFile(
    file: File,
    apiKey: string,
    /** Índice de fragmento para el tablero de progreso. */
    chunkIndex?: number,
    /** Duración del fragmento en segundos, para estimar el avance. */
    chunkSeconds?: number,
    model: string = GROQ_WHISPER_MODEL,
): Promise<string> {
    const fileSizeMB = file.size / (1024 * 1024);
    console.log(`[Groq] Iniciando transcripción de ${file.name} (${fileSizeMB.toFixed(2)}MB)`);

    // Timeout dinámico: 2min base + 30s por cada 5MB adicionales
    const baseSizeMB = 5;
    const baseTimeout = 120000; // 2 min
    const extraTimePerChunk = 30000; // 30s por cada 5MB
    const timeout = baseTimeout + Math.max(0, Math.ceil((fileSizeMB - baseSizeMB) / baseSizeMB)) * extraTimePerChunk;

    console.log(`[Groq] Timeout: ${(timeout / 1000).toFixed(0)}s for ${fileSizeMB.toFixed(1)}MB file`);

    const activeModel = (model && model !== 'auto') ? model : GROQ_WHISPER_MODEL;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', activeModel);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    try {
        // Whisper no expone streaming: la única respuesta llega al final. Para
        // no dejar la barra congelada durante el minuto que tarda, se avanza el
        // fragmento con una estimación basada en su duración real, y la UI lo
        // etiqueta como estimado en lugar de fingir que es una medida.
        let tick: ReturnType<typeof setInterval> | null = null;
        if (chunkIndex !== undefined) {
            const startedAt = Date.now();
            const expectedMs = Math.max(8000, (chunkSeconds || 60) * 1000 * 0.25);
            tick = setInterval(() => {
                const ratio = 1 - Math.exp(-(Date.now() - startedAt) / expectedMs);
                progress.setChunk(chunkIndex, 'active', Math.min(0.95, ratio));
            }, 500);
        }

        let response: Response;
        try {
            response = await fetchWithTimeout(`${GROQ_API_URL}/audio/transcriptions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: formData,
            }, { timeoutMs: timeout, label: 'Groq (transcripción)' });
        } finally {
            if (tick) clearInterval(tick);
        }

        // Cabeceras de cuota: vienen gratis en la respuesta y explican mejor
        // que cualquier mensaje genérico por qué el proceso se ralentiza.
        const remainingReqs = response.headers.get('x-ratelimit-remaining-requests');
        if (remainingReqs !== null && Number(remainingReqs) <= 2) {
            progress.pushEvent('warn', msg(
                `Quedan ${remainingReqs} peticiones en tu cuota de Groq de este minuto`,
                `${remainingReqs} requests left in your Groq quota for this minute`,
            ));
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('[Groq] Error API:', response.status, errorData);

            // Definitivos: reintentar sólo gastaría cuota y tiempo.
            if (response.status === 401 || response.status === 403) {
                throw new GroqError('API Key inválida. Verifica tu key de Groq.', false);
            }
            if (response.status === 413) {
                throw new GroqError('Archivo demasiado grande para Groq (límite 25MB).', false);
            }
            if (response.status === 400) {
                throw new GroqError(errorData?.error?.message || 'Audio no soportado por Groq.', false);
            }
            // Pasajeros: la propia respuesta suele decir cuánto esperar.
            if (response.status === 429) {
                throw new GroqError(
                    'Límite de Groq alcanzado. Espera un momento.',
                    true,
                    retryAfterMs(response, 10_000),
                );
            }
            if (response.status >= 500) {
                // Reintentable, pero sin perder lo que dice el servidor.
                throw new GroqError(
                    errorData?.error?.message || `Groq no disponible (${response.status}).`,
                    true,
                    retryAfterMs(response, 5_000),
                );
            }
            throw new GroqError(errorData?.error?.message || `Error del servidor (${response.status})`, false);
        }

        const data = await response.json();
        console.log('[Groq] Transcripción completada');

        // El texto sale de aquí SIN limpiar. Whisper también se atasca
        // repitiendo un segmento cuando hay silencio o ruido, y quien decide
        // qué hacer con esa racha es `transcribeWithLoopRecovery`: necesita
        // verla entera para saber por qué segundo del audio volver a empezar.
        // Tacharla aquí, como se hacía antes, borraba justo la pista que hacía
        // falta para recuperar el audio que venía detrás.
        if (data.segments && data.segments.length > 0) {
            return data.segments
                .map((seg: any) => {
                    const mins = Math.floor(seg.start / 60);
                    const secs = Math.floor(seg.start % 60);
                    const timestamp = `[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}]`;
                    return `${timestamp} ${seg.text.trim()}`;
                })
                .join('\n');
        }

        return data.text || '';
    } catch (err: any) {
        // La cancelación del usuario no es un fallo del fragmento: sube tal cual.
        if (isCancelledError(err)) throw err;
        if (chunkIndex !== undefined) progress.setChunk(chunkIndex, 'error');
        // Plazo agotado. Se reintenta —puede ser una lentitud pasajera— pero el
        // mensaje dice lo que de verdad ayuda si vuelve a pasar. Esto se
        // comprobaba con `err.name === 'AbortError'`, que nunca era cierto:
        // `fetchWithTimeout` ya traduce el aborto, así que el aviso caía en el
        // catch-all genérico y el usuario leía "Error de red".
        if (isTimeoutError(err)) {
            throw new GroqError(
                'La transcripción tardó demasiado (timeout). Intenta con un archivo más corto o comprimido.',
                true,
            );
        }
        if (err instanceof GroqError) throw err;
        // Fallo de red: sin respuesta HTTP, casi siempre pasajero.
        throw new GroqError(err?.message || 'Error de red al contactar con Groq', true);
    }
}

/**
 * Transcribe one or multiple chunks sequentially
 */
/**
 * Ventana de tokens por minuto.
 *
 * Sustituye a la espera fija de 6 s entre partes, que no tenía relación con
 * ningún límite real: con 8K TPM, encadenar peticiones cada 6 segundos es un
 * 429 garantizado. Aquí se espera lo que hace falta y ni un segundo más.
 */
const tpmWindow = { openedAt: 0, tokens: 0 };

async function reserveTpm(estimatedTokens: number): Promise<void> {
    const now = Date.now();
    if (now - tpmWindow.openedAt >= 60_000) {
        tpmWindow.openedAt = now;
        tpmWindow.tokens = 0;
    }

    const budget = GROQ_TPM * TPM_SAFETY;
    if (tpmWindow.tokens + estimatedTokens > budget) {
        const waitMs = Math.max(0, 60_000 - (now - tpmWindow.openedAt));
        if (waitMs > 0) {
            console.log(`[Groq] ⏳ TPM: esperando ${(waitMs / 1000).toFixed(0)}s para no pasar de ${GROQ_TPM} tokens/min`);
            progress.beginWait(Date.now() + waitMs, msg(
                'Esperando la ventana de cuota de Groq',
                'Waiting for the Groq quota window',
            ));
            await sleep(waitMs);
            progress.endWait();
        }
        tpmWindow.openedAt = Date.now();
        tpmWindow.tokens = 0;
    }
    tpmWindow.tokens += estimatedTokens;
}

/** Intentos por fragmento: el inicial más uno. Whisper no tiene otro modelo al que caer. */
const MAX_CHUNK_ATTEMPTS = 2;
/** Reintentos contra el MISMO modelo de texto antes de bajar por la cadena. */
const MAX_LLAMA_RETRIES = 2;
/** Plazo para que Groq empiece a responder la organización. */
const TIMEOUT_ORGANIZE_MS = 300_000;
/**
 * Transcribe los fragmentos en serie, tolerando el fallo de cualquiera.
 *
 * Antes, un fragmento que fallaba lanzaba y se llevaba por delante los que ya
 * estaban transcritos: el usuario perdía la hora de audio entera por un minuto
 * malo. Ahora cada fragmento se resuelve solo, se reintenta si el error tiene
 * arreglo, y lo que no se pueda recuperar queda como hueco señalado.
 */
export async function transcribeAudio(
    chunks: File[],
    apiKey: string,
    onProgress?: (progress: number) => void,
    /** Duración de cada fragmento en segundos, si se conoce. */
    chunkSeconds?: number[],
    model?: string,
): Promise<string> {
    if (!apiKey) throw new Error('API Key no configurada');
    if (!chunks.length) throw new Error('No hay archivos para transcribir');

    const total = chunks.length;
    const results: string[] = [];
    const failures: string[] = [];
    // Igual que en Gemini: el modelo elegido va primero, pero si se cae no se
    // lleva el audio por delante. Un 503 es del servidor, no del modelo.
    const chain = model && model !== 'auto'
        ? [model, ...GROQ_WHISPER_CHAIN.filter((x) => x !== model)]
        : [...GROQ_WHISPER_CHAIN];
    let avisadoDelCambio = false;

    console.log(`[Groq] Iniciando procesamiento de ${total} fragmentos`);

    // Comienzo de cada fragmento dentro del audio completo, para poder decir
    // qué tramo falta si alguno no sale.
    const startsAt = (i: number) =>
        (chunkSeconds ?? []).slice(0, i).reduce((sum, s) => sum + s, 0);

    for (let i = 0; i < total; i++) {
        throwIfCancelled();
        onProgress?.(Math.min(0.95, ((i / total) * 0.9) + 0.05));
        progress.setChunk(i, 'active', 0);

        let text: string | null = null;
        let lastError = '';
        let usedModel = chain[0];
        let gastados = 0;

        /**
         * Transcribe un audio concreto —el fragmento entero, o el recorte que
         * sigue a un atasco— agotando la cadena de modelos y sus reintentos.
         *
         * Devuelve `null` si no hay nada que hacer con él.
         */
        const transcribirAudio = async (audio: File, segundos: number): Promise<string | null> => {
            let salida: string | null = null;

            // Cada modelo de la cadena tiene sus reintentos; si se agotan y el
            // error era pasajero, se prueba el siguiente antes de dar el fragmento
            // por perdido.
            modelos:
            for (let mi = 0; mi < chain.length; mi++) {
                const candidato = chain[mi];
                usedModel = candidato;

                for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
                    gastados++;
                    progress.setChunkMeta(i, { attempts: gastados, requests: gastados, model: candidato });
                    try {
                        salida = await transcribeSingleFile(audio, apiKey, i, segundos, candidato);
                        break modelos;
                    } catch (err: any) {
                        if (isCancelledError(err)) throw err;
                        lastError = err?.message || String(err);
                        const retryable = err instanceof GroqError && err.retryable;

                        // Una key mala o un audio que no admite no mejoran con otro
                        // modelo: se abandona el fragmento aquí.
                        if (!retryable) {
                            console.error(`[Groq] ❌ Fragmento ${i + 1}/${total}: ${lastError}`);
                            break modelos;
                        }

                        if (attempt === MAX_CHUNK_ATTEMPTS) {
                            const siguiente = chain[mi + 1];
                            if (!siguiente) {
                                console.error(`[Groq] ❌ Fragmento ${i + 1}/${total}: ${lastError}`);
                                break modelos;
                            }
                            if (!avisadoDelCambio) {
                                avisadoDelCambio = true;
                                progress.pushEvent('warn', msg(
                                    `${candidato} sigue fallando; se continúa con ${siguiente}`,
                                    `${candidato} keeps failing; continuing with ${siguiente}`,
                                ));
                            }
                            console.warn(`[Groq] ⚠️  ${candidato} agotado → ${siguiente}`);
                            break;
                        }

                        const waitMs = (err as GroqError).retryAfterMs || 5_000;
                        console.warn(`[Groq] ⏳ Fragmento ${i + 1} falló (${lastError}), reintento en ${(waitMs / 1000).toFixed(0)}s`);
                        progress.pushEvent('retry', msg(
                            `Falló (${lastError}) — reintentando en ${Math.round(waitMs / 1000)}s`,
                            `Failed (${lastError}) — retrying in ${Math.round(waitMs / 1000)}s`,
                        ), { chunk: i });
                        progress.beginWait(Date.now() + waitMs, msg('Reintentando fragmento', 'Retrying chunk'));
                        await sleep(waitMs);
                        progress.endWait();
                    }
                }
            }

            return salida;
        };

        // Un modelo atascado repitiendo no pierde ya el resto del fragmento: se
        // conserva lo transcrito antes del atasco y se vuelve a pedir SÓLO el
        // audio que iba detrás. Whisper se engancha igual que Gemini —con
        // silencios largos suelta "gracias por ver el video" en bucle—, y la
        // única diferencia es que aquí la racha llega entera en la respuesta en
        // vez de verse llegar por el stream.
        const rescatado = await transcribeWithLoopRecovery({
            file: chunks[i],
            durationSec: chunkSeconds?.[i] ?? 0,
            label: `Groq ${i + 1}/${total}`,
            chunkIndex: i,
            timeBaseSec: startsAt(i),
            pass: async (audio, _offsetSec, remainingSec) => await transcribirAudio(audio, remainingSec) ?? '',
        });
        // Red de seguridad para las rachas que no dan para un rescate: cortas,
        // o sin marca de tiempo delante que diga desde dónde reintentar.
        const limpio = stripRepetitionRuns(rescatado.text);
        if (limpio.removed > 0) {
            console.warn(`[Groq] 🧹 Removed ${limpio.removed} chars of repetition`);
            progress.pushEvent('warn', msg(
                'Se eliminó una repetición del transcriptor',
                'Removed a repetition loop from the transcript',
            ), { chunk: i });
        }
        // El fragmento sólo se da por perdido si NO se salvó ni una palabra:
        // un rescate a medias sigue siendo audio transcrito.
        text = limpio.text.trim() ? limpio.text : null;

        if (text !== null) {
            results.push(text);
            progress.setChunk(i, 'done');
            progress.setChunkMeta(i, { model: usedModel, error: null });
        } else {
            failures.push(lastError);
            progress.setChunk(i, 'error');
            progress.pushEvent('warn', msg(
                `No se pudo transcribir: ${lastError}`,
                `Could not be transcribed: ${lastError}`,
            ), { chunk: i });
            progress.setChunkMeta(i, { error: lastError, attempts: gastados });

            // Hueco explícito: es preferible a un documento que parece completo.
            const desde = chunkSeconds ? secondsToLabel(startsAt(i)) : `${i + 1}/${total}`;
            const hasta = chunkSeconds ? secondsToLabel(startsAt(i) + (chunkSeconds[i] ?? 0)) : '';
            results.push(chunkSeconds
                ? `\n${msg('[⚠️ Falta el audio de', '[⚠️ Audio missing from')} ${desde} ${msg('a', 'to')} ${hasta}: ${lastError}]\n`
                : `\n${msg('[⚠️ Falta el fragmento', '[⚠️ Missing chunk')} ${desde}: ${lastError}]\n`);
        }

        onProgress?.(((i + 1) / total) * 0.9);
    }

    // Sólo es un fallo real si no se salvó nada.
    if (failures.length === total) {
        throw new Error(failures[0]);
    }
    if (failures.length > 0) {
        console.warn(`[Groq] ⚠️  ${failures.length}/${total} fragmentos perdidos`);
        progress.pushEvent('warn', msg(
            `Transcripción con ${failures.length} hueco(s) señalado(s)`,
            `Transcript has ${failures.length} gap(s) marked`,
        ));
    }

    onProgress?.(1);
    return results.join('\n\n');
}

// ---------------------------------------------------------------------------
// Modelos y límites del free tier de Groq
// Comprobado el 14/08/2026 contra console.groq.com/docs/models y /rate-limits
// ---------------------------------------------------------------------------

/**
 * Cadena de modelos para la organización de apuntes.
 *
 * Llama salió de la ecuación: `meta-llama/llama-4-scout-17b-16e-instruct`
 * quedó deprecado el 17/06/2026, y los Llama 3.x que quedaban en producción
 * (3.1-8b-instant y 3.3-70b-versatile) se apagan el 16/08/2026. Groq recomienda
 * migrar a gpt-oss. Se deja una cadena corta porque los retiros son continuos:
 * si el primero desaparece, el siguiente responde sin que haya que publicar.
 */
export const GROQ_MODEL_CHAIN = [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b',
] as const;

/** Transcripción: sigue siendo producción y no tiene sustituto mejor. */
export const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

/** Cadena de Whisper: el turbo primero, el estándar como red de seguridad. */
export const GROQ_WHISPER_CHAIN = [
    'whisper-large-v3-turbo',
    'whisper-large-v3',
] as const;

export const GROQ_TRANSCRIPTION_MODELS = [
    { id: 'auto', label: 'Auto', desc: 'Whisper v3 Turbo' },
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', desc: 'Groq Whisper' },
    { id: 'whisper-large-v3', label: 'Whisper Large v3', desc: 'Groq Whisper Standard' },
] as const;

/**
 * Tokens por minuto del free tier: 8K para toda la gama gpt-oss/qwen.
 *
 * El troceado anterior (28.000 caracteres ≈ 7K tokens de entrada + 4K de
 * salida = 11K) estaba calculado para los 30K TPM del Llama 4 Scout: con 8K
 * cada petición nacía pasada de límite y comía 429 seguro.
 */
const GROQ_TPM = 8000;
/** Margen para no apurar la ventana al 100%. */
const TPM_SAFETY = 0.85;
/** Tope de salida por petición. */
const MAX_OUTPUT_TOKENS = 3000;
/** ~4 caracteres por token: entrada que cabe dejando sitio a la respuesta. */
const MAX_CHARS_PER_CHUNK = (GROQ_TPM * TPM_SAFETY - MAX_OUTPUT_TOKENS) * 4;

import type { SummaryLevel } from './store';
import { buildNotesPrompt, type NotesPart } from './notes-prompt';

export async function organizeNotes(
    transcription: string,
    apiKey: string,
    onStep?: (step: number) => void,
    summaryLevel: SummaryLevel = 'short',
    outputLanguage: string = 'auto'
): Promise<string> {
    if (!apiKey) throw new Error('API Key no configurada');
    if (!transcription) throw new Error('No hay transcripción para organizar');

    onStep?.(1);

    // Split transcription into manageable chunks
    const chunks = splitTranscription(transcription, MAX_CHARS_PER_CHUNK);

    if (chunks.length === 1) {
        // Single chunk — full format
        const result = await callTextModel(chunks[0], apiKey, undefined, summaryLevel, outputLanguage, [0, 1]);
        onStep?.(4);
        if (!result) throw new Error('La IA no generó contenido. Intenta de nuevo.');
        onStep?.(5);
        return result;
    }

    // Multiple chunks — process each, then merge
    onStep?.(2);
    progress.pushEvent('info', msg(
        `Transcripción larga: se organiza en ${chunks.length} partes`,
        `Long transcript: organizing it in ${chunks.length} parts`,
    ));
    const partResults: string[] = [];
    let fallos = 0;

    for (let i = 0; i < chunks.length; i++) {
        const partLabel = `Parte ${i + 1}/${chunks.length}`;

        // Una parte que falla no puede tirar las que ya están redactadas: se
        // marca el hueco y se sigue. La espera entre partes la gobierna la
        // ventana de TPM dentro de callTextModel, no un temporizador a ojo.
        try {
            const result = await callTextModel(
                chunks[i],
                apiKey,
                { index: i, total: chunks.length },
                summaryLevel,
                outputLanguage,
                [i / chunks.length, (i + 1) / chunks.length],
            );
            if (result) partResults.push(result);
            else throw new Error('respuesta vacía del modelo');
        } catch (err: any) {
            if (isCancelledError(err)) throw err;
            fallos++;
            const motivo = err?.message || String(err);
            console.error(`[Groq] ❌ ${partLabel}: ${motivo}`);
            progress.pushEvent('warn', msg(
                `${partLabel} no se pudo organizar: ${motivo}`,
                `${partLabel} could not be organized: ${motivo}`,
            ));
            partResults.push(
                `\n${msg('[⚠️ Falta esta parte de los apuntes', '[⚠️ This part of the notes is missing')} (${partLabel}): ${motivo}]\n`
            );
        }

        onStep?.(2 + Math.floor(((i + 1) / chunks.length) * 2));
    }

    // Sólo es un fallo real si no salió ninguna parte.
    if (fallos === chunks.length) {
        throw new Error('La IA no generó contenido. Intenta de nuevo.');
    }
    if (fallos > 0) {
        progress.pushEvent('warn', msg(
            `Apuntes con ${fallos} parte(s) sin generar`,
            `Notes with ${fallos} part(s) missing`,
        ));
    }

    onStep?.(5);
    return partResults.join('\n\n---\n\n');
}

function splitTranscription(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    const lines = text.split('\n');
    let current = '';

    for (const line of lines) {
        // Una línea más larga que el tope entera no cabe en ningún trozo: sin
        // este corte duro, una transcripción sin saltos de línea viajaba de una
        // pieza y reventaba el límite de tokens por minuto del modelo.
        if (line.length > maxChars) {
            if (current.trim()) { chunks.push(current.trim()); current = ''; }
            for (let i = 0; i < line.length; i += maxChars) {
                chunks.push(line.slice(i, i + maxChars).trim());
            }
            continue;
        }

        if (current.length + line.length + 1 > maxChars && current.length > 0) {
            chunks.push(current.trim());
            current = '';
        }
        current += line + '\n';
    }
    if (current.trim()) chunks.push(current.trim());

    return chunks;
}

async function callTextModel(
    transcriptionChunk: string,
    apiKey: string,
    part: NotesPart | undefined,
    summaryLevel: SummaryLevel = 'short',
    outputLanguage: string = 'auto',
    /** Tramo [desde, hasta] de la etapa 'organize' que cubre esta llamada. */
    stageRange: [number, number] = [0, 1],
    /** Posición en la cadena de modelos e intentos ya gastados. */
    opts: { modelIndex?: number; attempt?: number } = {},
): Promise<string | null> {
    const modelIndex = Math.min(opts.modelIndex ?? 0, GROQ_MODEL_CHAIN.length - 1);
    const attempt = opts.attempt ?? 0;
    const model = GROQ_MODEL_CHAIN[modelIndex];

    /** Siguiente modelo de la cadena, si queda alguno. */
    const nextModel = (reason: string): Promise<string | null> | null => {
        if (modelIndex + 1 >= GROQ_MODEL_CHAIN.length) return null;
        console.warn(`[Groq] ⚠️  ${model}: ${reason} → ${GROQ_MODEL_CHAIN[modelIndex + 1]}`);
        progress.pushEvent('warn', msg(
            `${model} no disponible — probando ${GROQ_MODEL_CHAIN[modelIndex + 1]}`,
            `${model} unavailable — trying ${GROQ_MODEL_CHAIN[modelIndex + 1]}`,
        ));
        return callTextModel(transcriptionChunk, apiKey, part, summaryLevel, outputLanguage,
            stageRange, { modelIndex: modelIndex + 1, attempt: 0 });
    };
    // El prompt es el compartido: lo que cambia entre proveedores es la red,
    // no lo que se le pide al modelo. Aquí vivían cuatro textos propios —uno
    // por nivel más el de continuación— que eran la versión sin refactorizar de
    // este mismo prompt, y que nunca recibieron los arreglos que sí tuvo el
    // otro lado.
    //
    // Va entero como mensaje de usuario, con la transcripción dentro, igual que
    // en Gemini: el prompt ya lleva su propio sitio para el texto.
    const prompt = buildNotesPrompt(transcriptionChunk, summaryLevel, outputLanguage, part);

    // El formato de salida lo dicta el propio prompt: sus encabezados ## son
    // el índice del documento y sirven para medir cuánto lleva escrito.
    const expectedSections = Math.max(1, (prompt.match(/^##\s/gm) || []).length);
    const [rangeFrom, rangeTo] = stageRange;

    // Reservar hueco en la ventana de TPM antes de gastar la petición.
    const estimatedTokens = Math.ceil(prompt.length / 4) + MAX_OUTPUT_TOKENS;
    await reserveTpm(estimatedTokens);

    const response = await fetchWithTimeout(`${GROQ_API_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: MAX_OUTPUT_TOKENS,
            // Misma petición y mismos tokens que sin streaming: sólo cambia que
            // el texto llega a trozos, que es lo que permite mostrar avance real.
            stream: true,
        }),
    }, { timeoutMs: TIMEOUT_ORGANIZE_MS, label: `Groq (${model})` });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const apiMessage: string = errorData?.error?.message || `Error del servidor (${response.status})`;

        // Modelo retirado o inexistente: no hay nada que reintentar, se baja
        // por la cadena. Groq jubila modelos con frecuencia y esto evita que la
        // app se quede muerta hasta que alguien publique una versión nueva.
        const decommissioned = response.status === 404
            || (response.status === 400 && /decommission|deprecat|does not exist|not found/i.test(apiMessage));
        if (decommissioned) {
            const fallback = nextModel('modelo retirado');
            if (fallback) return fallback;
            throw new Error(`El modelo ${model} ya no está disponible en Groq y no queda alternativa configurada.`);
        }

        if (response.status === 401 || response.status === 403) {
            throw new Error('API Key inválida. Verifica tu key de Groq.');
        }

        if (response.status === 429) {
            // La propia respuesta dice cuánto esperar; y el reintento está
            // acotado, porque antes se llamaba a sí misma sin límite.
            if (attempt >= MAX_LLAMA_RETRIES) {
                const fallback = nextModel('límite de peticiones persistente');
                if (fallback) return fallback;
                throw new Error('Límite de Groq alcanzado. Espera un momento e inténtalo de nuevo.');
            }
            const retryAfter = Number(response.headers.get('retry-after')) * 1000;
            const waitMs = isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60000) : 10000;
            progress.pushEvent('retry', msg(
                `Límite de Groq alcanzado — reintentando en ${Math.round(waitMs / 1000)}s`,
                `Groq rate limit hit — retrying in ${Math.round(waitMs / 1000)}s`,
            ));
            progress.beginWait(Date.now() + waitMs, msg('Límite de peticiones de Groq', 'Groq rate limit'));
            await sleep(waitMs);
            progress.endWait();
            return callTextModel(transcriptionChunk, apiKey, part, summaryLevel, outputLanguage,
                stageRange, { modelIndex, attempt: attempt + 1 });
        }

        if (response.status >= 500) {
            if (attempt >= MAX_LLAMA_RETRIES) {
                const fallback = nextModel(`saturado (${response.status})`);
                if (fallback) return fallback;
                throw new Error(apiMessage);
            }
            await sleep(5000);
            return callTextModel(transcriptionChunk, apiKey, part, summaryLevel, outputLanguage,
                stageRange, { modelIndex, attempt: attempt + 1 });
        }

        throw new Error(apiMessage);
    }

    let content = '';
    let loopCheckAt = 3000;

    const publish = (): boolean | void => {
        progress.setStreamCounters(content.length);
        if (content.length >= loopCheckAt) {
            loopCheckAt = content.length + 3000;
            if (tailRepetitionRun(content)) {
                console.warn('[Groq] 🔁 Repetition loop detected — cutting the stream');
                progress.pushEvent('warn', msg(
                    'El modelo se atascó repitiendo — se corta ahí',
                    'The model got stuck repeating — cutting it short',
                ));
                return false;   // corta el stream: la respuesta ya no aporta
            }
        }
        const headings = content.match(/^##\s+.*$/gm) || [];
        const ratio = Math.min(0.97, Math.max(
            headings.length / expectedSections,
            Math.min(0.15, content.length / 6000),
        ));
        const current = headings.length ? headings[headings.length - 1].replace(/^##\s+/, '') : null;
        progress.setStage('organize', rangeFrom + (rangeTo - rangeFrom) * ratio, current
            ? msg(`Redactando: ${current}`, `Writing: ${current}`)
            : msg('Analizando la transcripción', 'Analyzing the transcript'));
    };

    // `finish_reason` viaja en el último trozo del stream y hasta ahora se
    // tiraba. Es el único aviso de que el modelo se quedó sin sitio para
    // escribir: sin leerlo, unos apuntes cortados a la mitad salen del pipeline
    // con el mismo aspecto que unos terminados.
    let finishReason: string | null = null;

    await forEachSSE(response, `Groq (${model})`, (parsed) => {
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (!delta) return;
        content += delta;
        return publish();
    });

    let { text: cleaned } = stripRepetitionRuns(content);

    // 'length' es el `MAX_TOKENS` de la API de estilo OpenAI.
    if (cleaned && finishReason === 'length') {
        const hasta = lastTimestampLabel(cleaned);
        console.warn(`[Groq] ⚠️  Apuntes cortados por límite de tokens (${model})`);
        progress.pushEvent('warn', msg(
            'Los apuntes se cortaron: el modelo llegó a su límite de escritura',
            'The notes were cut short: the model hit its writing limit',
        ));
        cleaned += '\n\n' + msg(
            `[⚠️ Los apuntes se cortan aquí: el modelo llegó a su límite de escritura${hasta ? ` y sólo cubren la clase hasta ${hasta.slice(1, -1)}` : ''}. La transcripción está completa.]`,
            `[⚠️ The notes stop here: the model hit its writing limit${hasta ? ` and only cover the recording up to ${hasta.slice(1, -1)}` : ''}. The transcript is complete.]`,
        );
    }

    return cleaned || null;
}

/** Plazo para validar una key: si en 15s no contesta, no contesta. */
const TIMEOUT_VALIDATE_MS = 15_000;

export async function validateGroqKey(apiKey: string): Promise<boolean> {
    try {
        // `detached`: la validación se lanza desde la configuración, fuera de
        // cualquier ejecución. Iba con `fetch` pelado —sin plazo— y una
        // conexión colgada dejaba el modal esperando para siempre.
        const response = await fetchWithTimeout(`${GROQ_API_URL}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        }, { timeoutMs: TIMEOUT_VALIDATE_MS, label: 'Groq', detached: true });
        return response.ok;
    } catch (e) {
        console.error('Groq validation error:', e);
        return false;
    }
}
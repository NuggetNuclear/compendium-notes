/**
 * Motor de progreso estructurado.
 *
 * Sustituye al par (processingState, processingProgress) por un modelo que
 * describe QUÉ se está haciendo, CUÁNTO falta y CUÁNDO fue la última señal de
 * vida. Todo lo que publica sale de información que el pipeline ya tenía
 * (bytes subidos, timestamps del stream, chunks completados, cabeceras de
 * rate-limit): no cuesta ni una sola request extra.
 *
 * Reglas de diseño:
 *  - El progreso global es la suma ponderada de las etapas por su duración
 *    ESPERADA, no por un reparto fijo. Así el 50% significa "va por la mitad
 *    del tiempo", que es lo que el usuario lee cuando mira una barra.
 *  - Las expectativas se calibran solas: cada ejecución guarda su ritmo real
 *    en localStorage y la siguiente estima mejor.
 *  - Nunca retrocede dentro de una ejecución.
 *  - `lastBeat` marca la última señal real. La UI lo usa para diferenciar
 *    "trabajando" de "colgado" sin tener que inventarse animaciones.
 */

import { sanitizeDuration } from './duration';

export type StageId = 'prepare' | 'upload' | 'transcribe' | 'organize';
export type StageStatus = 'pending' | 'active' | 'waiting' | 'done' | 'error';
export type EventKind = 'info' | 'warn' | 'success' | 'retry' | 'error';

export interface StageState {
    id: StageId;
    status: StageStatus;
    /** 0-1 dentro de la etapa. */
    progress: number;
    /** Duración esperada en ms — define el peso de la etapa en la barra global. */
    expectedMs: number;
    startedAt: number | null;
    endedAt: number | null;
    /** Texto corto y concreto: "fragmento 3 de 7", "minuto 34 de 78". */
    detail: string;
}

export interface ChunkState {
    index: number;
    status: 'pending' | 'active' | 'done' | 'error';
    progress: number;
    /** Rango temporal que cubre el fragmento, en segundos. */
    startSec: number;
    endSec: number;

    // Detalle por fragmento: lo que hasta ahora sólo existía en la consola.
    /** Intentos consumidos (el inicial cuenta como 1). */
    attempts: number;
    /** Peticiones HTTP gastadas por este fragmento. */
    requests: number;
    /** Modelo que lo atendió en el último intento. */
    model: string | null;
    /** Tokens de salida generados. */
    tokens: number;
    /** Segundos de audio realmente transcritos dentro del fragmento. */
    coveredSec: number;
    /** Motivo del último fallo, si lo hubo. */
    error: string | null;
}

export interface ActivityEvent {
    id: number;
    at: number;
    kind: EventKind;
    text: string;
    /** Etapa en la que ocurrió, para poder agrupar el registro. */
    stage: StageId | null;
    /** Fragmento al que se refiere, si va dirigido a uno concreto. */
    chunk: number | null;
}

/** Metadatos opcionales al publicar un evento. */
export interface EventMeta {
    chunk?: number;
    stage?: StageId;
}

export interface ProgressCounters {
    /** Segundos de audio ya transcritos / totales. La métrica más honesta que hay. */
    audioDoneSec: number;
    audioTotalSec: number;
    /** Caracteres recibidos por streaming en la etapa activa. */
    chars: number;
    /** Tokens de salida generados (los reporta la propia respuesta). */
    tokens: number;
    bytesUp: number;
    bytesTotal: number;
}

export interface ProgressSnapshot {
    active: boolean;
    startedAt: number | null;
    finishedAt: number | null;
    stages: StageState[];
    activeStage: StageId | null;
    /** 0-1 global, monótono. */
    global: number;
    /** Milisegundos restantes estimados, o null si aún no hay datos suficientes. */
    etaMs: number | null;
    detail: string;
    chunks: ChunkState[];
    model: string | null;
    attempt: { n: number; max: number } | null;
    /** Timestamp hasta el que el pipeline está esperando a propósito (backoff). */
    waitUntil: number | null;
    waitReason: string | null;
    counters: ProgressCounters;
    events: ActivityEvent[];
    /** Última señal real recibida del pipeline. */
    lastBeat: number;
    error: string | null;
    provider: 'groq' | 'gemini' | null;
    fileName: string | null;
}

// ---------------------------------------------------------------------------
// Calibración: expectativas por etapa, ajustadas con lo observado
// ---------------------------------------------------------------------------

/** Coste esperado por minuto de audio, en ms. Punto de partida razonable. */
const BASE_MS_PER_AUDIO_MIN: Record<string, Record<StageId, number>> = {
    groq: { prepare: 900, upload: 0, transcribe: 1400, organize: 700 },
    gemini: { prepare: 900, upload: 250, transcribe: 1900, organize: 900 },
};

/** Suelo por etapa: ninguna llamada a un modelo baja de aquí. */
const FLOOR_MS: Record<StageId, number> = {
    prepare: 1500,
    upload: 2000,
    transcribe: 8000,
    organize: 12000,
};

/**
 * Aquí vivía una calibración: se guardaba en `localStorage` la media móvil
 * exponencial del ratio real/esperado de cada etapa, por proveedor, para afinar
 * la estimación. Sesenta líneas de estado aprendido para alimentar un número
 * que la pantalla enseña como "Unos 3 minutos". La estimación redondeada sale
 * igual de la tabla de arriba, y sin estado que pueda quedarse corrupto.
 */
export function expectedStageMs(
    provider: 'groq' | 'gemini',
    stage: StageId,
    audioMinutes: number,
): number {
    const base = BASE_MS_PER_AUDIO_MIN[provider]?.[stage] ?? 0;
    if (base === 0) return 0;
    const minutes = Number.isFinite(audioMinutes) ? Math.max(1, audioMinutes) : 1;
    return Math.max(FLOOR_MS[stage], base * minutes);
}

// ---------------------------------------------------------------------------
// Textos bilingües emitidos desde la capa de red
// ---------------------------------------------------------------------------

let currentLocale: 'es' | 'en' = 'es';

export function setProgressLocale(locale: 'es' | 'en') {
    currentLocale = locale;
}

/**
 * Los detalles de etapa y los eventos nacen dentro de gemini.ts / groq.ts,
 * donde no hay acceso al store. `m()` deja el par de textos junto al código
 * que lo emite en lugar de inventar una clave de i18n por cada matiz.
 */
export function m(es: string, en: string): string {
    return currentLocale === 'es' ? es : en;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const MAX_EVENTS = 40;
const EMIT_INTERVAL_MS = 120;

const emptySnapshot = (): ProgressSnapshot => ({
    active: false,
    startedAt: null,
    finishedAt: null,
    stages: [],
    activeStage: null,
    global: 0,
    etaMs: null,
    detail: '',
    chunks: [],
    model: null,
    attempt: null,
    waitUntil: null,
    waitReason: null,
    counters: { audioDoneSec: 0, audioTotalSec: 0, chars: 0, tokens: 0, bytesUp: 0, bytesTotal: 0 },
    events: [],
    lastBeat: Date.now(),
    error: null,
    provider: null,
    fileName: null,
});

export interface StartOptions {
    provider: 'groq' | 'gemini';
    fileName: string;
    fileSize: number;
    /** Duración del audio en segundos, si ya se conoce. */
    durationSeconds?: number;
    /** Etapas que este flujo va a recorrer, en orden. */
    stages: StageId[];
    locale?: 'es' | 'en';
}

class ProgressTracker {
    private snap: ProgressSnapshot = emptySnapshot();
    private listeners = new Set<() => void>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private eventSeq = 0;
    private audioMinutes = 1;

    // -- suscripción (useSyncExternalStore) --------------------------------

    subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    getSnapshot = () => this.snap;

    /** Emite como mucho cada EMIT_INTERVAL_MS; `now` fuerza el flush. */
    private commit(now = false) {
        if (now) {
            if (this.timer) { clearTimeout(this.timer); this.timer = null; }
            this.snap = { ...this.snap };
            this.listeners.forEach((l) => l());
            return;
        }
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.snap = { ...this.snap };
            this.listeners.forEach((l) => l());
        }, EMIT_INTERVAL_MS);
    }

    private beat() {
        this.snap.lastBeat = Date.now();
    }

    private stage(id: StageId): StageState | undefined {
        return this.snap.stages.find((s) => s.id === id);
    }

    // -- ciclo de vida -----------------------------------------------------

    start(opts: StartOptions) {
        if (opts.locale) setProgressLocale(opts.locale);
        // Una duración no finita (WebM sin índice) hacía Infinity el peso de
        // cada etapa, y con eso la barra global salía NaN: "NaN%" en pantalla.
        const durationSeconds = sanitizeDuration(opts.durationSeconds);
        const rawMinutes = durationSeconds > 0 ? durationSeconds / 60 : opts.fileSize / (1024 * 1024);
        const audioMinutes = Math.min(600, Math.max(1, Number.isFinite(rawMinutes) ? rawMinutes : 1));
        this.audioMinutes = audioMinutes;
        this.eventSeq = 0;

        this.snap = {
            ...emptySnapshot(),
            active: true,
            startedAt: Date.now(),
            provider: opts.provider,
            fileName: opts.fileName,
            stages: opts.stages.map((id) => ({
                id,
                status: 'pending' as StageStatus,
                progress: 0,
                expectedMs: expectedStageMs(opts.provider, id, audioMinutes),
                startedAt: null,
                endedAt: null,
                detail: '',
            })),
            counters: {
                audioDoneSec: 0,
                audioTotalSec: durationSeconds,
                chars: 0,
                tokens: 0,
                bytesUp: 0,
                bytesTotal: opts.fileSize,
            },
        };
        this.commit(true);
    }

    /**
     * Reajusta la lista de etapas cuando el flujo real se conoce a mitad de
     * camino (p. ej. un audio largo evita la subida y va por fragmentos).
     * Las etapas ya vividas conservan su estado.
     */
    replan(stages: StageId[]) {
        if (!this.snap.active || !this.snap.provider) return;
        const provider = this.snap.provider;
        this.snap.stages = stages.map((id) => {
            const prev = this.stage(id);
            return prev ?? {
                id,
                status: 'pending' as StageStatus,
                progress: 0,
                expectedMs: expectedStageMs(provider, id, this.audioMinutes),
                startedAt: null,
                endedAt: null,
                detail: '',
            };
        });
        this.recompute();
        this.commit(true);
    }

    /** La duración real sólo se conoce tras decodificar: reajusta expectativas. */
    setDuration(seconds: number) {
        const safe = sanitizeDuration(seconds);
        if (!safe || !this.snap.active) return;
        this.snap.counters.audioTotalSec = safe;
        this.audioMinutes = Math.min(600, Math.max(1, safe / 60));
        const provider = this.snap.provider;
        if (provider) {
            this.snap.stages.forEach((s) => {
                // La etapa en curso mantiene su expectativa: cambiarla a media
                // ejecución haría saltar la barra global.
                if (s.status === 'pending') {
                    s.expectedMs = expectedStageMs(provider, s.id, this.audioMinutes);
                }
            });
        }
        this.recompute();
        this.commit();
    }

    beginStage(id: StageId, detail = '') {
        const s = this.stage(id);
        if (!s) return;
        // Cerrar las anteriores que quedaran abiertas (p. ej. flujos sin upload).
        this.snap.stages.forEach((prev) => {
            if (prev.id !== id && (prev.status === 'active' || prev.status === 'waiting')) {
                this.finishStage(prev.id);
            }
        });
        s.status = 'active';
        s.startedAt = Date.now();
        s.progress = 0;
        s.detail = detail;
        this.snap.activeStage = id;
        this.snap.detail = detail;
        this.beat();
        this.recompute();
        this.commit(true);
    }

    setStage(id: StageId, progress: number, detail?: string) {
        const s = this.stage(id);
        if (!s) return;
        if (s.status === 'pending') { s.status = 'active'; s.startedAt = Date.now(); }
        if (s.status === 'waiting') s.status = 'active';
        if (Number.isFinite(progress)) {
            s.progress = Math.min(1, Math.max(s.progress, progress));
        }
        if (detail !== undefined) { s.detail = detail; this.snap.detail = detail; }
        this.snap.waitUntil = null;
        this.snap.waitReason = null;
        this.beat();
        this.recompute();
        this.commit();
    }

    finishStage(id: StageId, detail?: string) {
        const s = this.stage(id);
        if (!s || s.status === 'done') return;
        s.progress = 1;
        s.status = 'done';
        s.endedAt = Date.now();
        if (detail !== undefined) s.detail = detail;
        if (this.snap.activeStage === id) this.snap.activeStage = null;
        this.snap.waitUntil = null;
        this.snap.waitReason = null;
        this.beat();
        this.recompute();
        this.commit(true);
    }

    finish() {
        this.snap.stages.forEach((s) => {
            if (s.status !== 'done') { s.status = 'done'; s.progress = 1; s.endedAt = Date.now(); }
        });
        this.snap.global = 1;
        this.snap.etaMs = 0;
        this.snap.active = false;
        this.snap.finishedAt = Date.now();
        this.snap.activeStage = null;
        this.beat();
        this.commit(true);
    }

    fail(message: string) {
        const active = this.snap.activeStage;
        if (active) {
            const s = this.stage(active);
            if (s) { s.status = 'error'; s.endedAt = Date.now(); }
        }
        this.snap.error = message;
        this.snap.active = false;
        this.snap.waitUntil = null;
        this.pushEvent('error', message);
        this.beat();
        this.commit(true);
    }

    resetIdle() {
        this.snap = emptySnapshot();
        this.commit(true);
    }

    // -- señales finas -----------------------------------------------------

    /** Bytes subidos de verdad (evento progress del XHR). */
    setUploadBytes(loaded: number, total: number) {
        this.snap.counters.bytesUp = loaded;
        if (total) this.snap.counters.bytesTotal = total;
        this.beat();
        this.commit();
    }

    /** Segundos de audio ya transcritos — la señal más fiel de "cuánto falta". */
    setAudioDone(seconds: number) {
        this.snap.counters.audioDoneSec = Math.max(this.snap.counters.audioDoneSec, seconds);
        this.beat();
        this.commit();
    }

    setStreamCounters(chars: number, tokens?: number) {
        this.snap.counters.chars = chars;
        if (tokens !== undefined) this.snap.counters.tokens = tokens;
        this.beat();
        this.commit();
    }

    setModel(model: string | null, attempt?: { n: number; max: number } | null) {
        const changed = this.snap.model !== model;
        this.snap.model = model;
        if (attempt !== undefined) this.snap.attempt = attempt;
        if (changed && model) this.beat();
        this.commit();
    }

    /** Espera deliberada (backoff / rate limit). La UI muestra cuenta atrás. */
    beginWait(untilTs: number, reason: string) {
        this.snap.waitUntil = untilTs;
        this.snap.waitReason = reason;
        const active = this.snap.activeStage;
        if (active) {
            const s = this.stage(active);
            if (s) s.status = 'waiting';
        }
        this.beat();
        this.commit(true);
    }

    endWait() {
        if (!this.snap.waitUntil) return;
        this.snap.waitUntil = null;
        this.snap.waitReason = null;
        const active = this.snap.activeStage;
        if (active) {
            const s = this.stage(active);
            if (s && s.status === 'waiting') s.status = 'active';
        }
        this.beat();
        this.commit(true);
    }

    // -- fragmentos --------------------------------------------------------

    initChunks(ranges: { startSec: number; endSec: number }[]) {
        this.snap.chunks = ranges.map((r, i) => ({
            index: i,
            status: 'pending' as const,
            progress: 0,
            startSec: r.startSec,
            endSec: r.endSec,
            attempts: 0,
            requests: 0,
            model: null,
            tokens: 0,
            coveredSec: 0,
            error: null,
        }));
        this.beat();
        this.commit(true);
    }

    setChunk(index: number, status: ChunkState['status'], progress = status === 'done' ? 1 : 0) {
        const c = this.snap.chunks[index];
        if (!c) return;
        c.status = status;
        c.progress = status === 'done' ? 1 : Math.max(c.progress, progress);
        c.coveredSec = (c.endSec - c.startSec) * c.progress;

        // Los segundos de audio ya cubiertos (incluidos los parciales del
        // fragmento en curso) mueven la etapa de transcripción. Es progreso
        // real: sale de los timestamps que el propio modelo va emitiendo.
        const totalSec = this.snap.chunks.reduce((sum, x) => sum + (x.endSec - x.startSec), 0);
        const doneSec = this.snap.chunks.reduce((sum, x) => sum + (x.endSec - x.startSec) * x.progress, 0);
        this.snap.counters.audioDoneSec = Math.max(this.snap.counters.audioDoneSec, doneSec);

        const finished = this.snap.chunks.filter((x) => x.status === 'done').length;
        this.setStage(
            'transcribe',
            totalSec > 0 ? doneSec / totalSec : 0,
            m(`Fragmento ${Math.min(finished + 1, this.snap.chunks.length)} de ${this.snap.chunks.length}`,
              `Chunk ${Math.min(finished + 1, this.snap.chunks.length)} of ${this.snap.chunks.length}`),
        );
        this.beat();
        this.commit();
    }

    // -- registro de actividad --------------------------------------------

    pushEvent(kind: EventKind, text: string, meta: EventMeta = {}) {
        this.snap.events = [
            ...this.snap.events.slice(-(MAX_EVENTS - 1)),
            {
                id: ++this.eventSeq,
                at: Date.now(),
                kind,
                text,
                // La etapa se deduce sola: quien emite el evento casi nunca la sabe.
                stage: meta.stage ?? this.snap.activeStage,
                chunk: meta.chunk ?? null,
            },
        ];
        this.beat();
        this.commit(kind !== 'info');
    }

    /** Detalle acumulado de un fragmento (modelo, intentos, tokens, fallo). */
    setChunkMeta(index: number, patch: Partial<Omit<ChunkState, 'index'>>) {
        const c = this.snap.chunks[index];
        if (!c) return;
        Object.assign(c, patch);
        this.beat();
        this.commit();
    }

    // -- cálculo global ----------------------------------------------------

    private recompute() {
        const stages = this.snap.stages;
        const totalWeight = stages.reduce((sum, s) => sum + s.expectedMs, 0) || 1;

        let doneWeight = 0;
        for (const s of stages) {
            doneWeight += s.expectedMs * (s.status === 'done' ? 1 : s.progress);
        }
        const global = Math.min(1, doneWeight / totalWeight);
        // Un peso corrupto no debe poder envenenar la barra: si sale NaN se
        // conserva el último valor bueno en lugar de pintar "NaN%".
        if (Number.isFinite(global)) {
            this.snap.global = Math.max(this.snap.global, global);
        }

        this.snap.etaMs = this.computeEta();
    }

    /**
     * ETA = lo que falta de la etapa activa (a su ritmo real medido) + la
     * expectativa de las pendientes, corregida por lo bien que iba el ritmo
     * hasta ahora. Devuelve null hasta tener una medida creíble.
     */
    private computeEta(): number | null {
        const now = Date.now();
        const stages = this.snap.stages;
        let remaining = 0;
        let measured = false;

        for (const s of stages) {
            if (s.status === 'done') continue;

            if ((s.status === 'active' || s.status === 'waiting') && s.startedAt) {
                const elapsed = now - s.startedAt;
                if (s.progress > 0.02 && elapsed > 1500) {
                    // Ritmo real de esta etapa.
                    remaining += (elapsed / s.progress) * (1 - s.progress);
                    measured = true;
                } else {
                    remaining += Math.max(0, s.expectedMs - elapsed);
                }
                // Una espera por rate-limit se suma tal cual: es tiempo real.
                if (s.status === 'waiting' && this.snap.waitUntil) {
                    remaining += Math.max(0, this.snap.waitUntil - now);
                }
            } else {
                remaining += s.expectedMs;
            }
        }

        if (!measured && !this.snap.startedAt) return null;
        return Math.max(0, Math.round(remaining));
    }
}

export const progress = new ProgressTracker();

/** Formatea ms como "2 min 10 s" / "45 s". Pensado para la ETA. */
export function formatEta(ms: number | null, locale: 'es' | 'en'): string | null {
    if (ms === null) return null;
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 5) return locale === 'es' ? 'unos segundos' : 'a few seconds';
    if (totalSec < 60) return `${totalSec} s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 10 && sec >= 10) return `${min} min ${sec} s`;
    return `${min} min`;
}

/** mm:ss para contadores de tiempo transcurrido. */
export function formatClock(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

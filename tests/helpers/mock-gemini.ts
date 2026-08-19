import { vi } from 'vitest';
import { resetModelHealth } from '../../src/lib/gemini';

/**
 * Arnés de pruebas para las rutas de red de Gemini y Groq.
 *
 * Sustituye `fetch` y `XMLHttpRequest` (la subida usa XHR para poder leer el
 * progreso de bytes) y registra cada petición, de modo que los tests pueden
 * afirmar CUÁNTAS peticiones se hicieron y CON QUÉ — que es donde estaban los
 * problemas reales: fragmentos repetidos de más, cuota quemada, reintentos que
 * no reintentaban sólo lo roto.
 */

export interface RecordedCall {
    url: string;
    model: string;
    /** URIs de los audios enviados: identifican qué fragmento va en la petición. */
    uris: string[];
    prompt: string;
    body: any;
    provider: 'gemini' | 'groq';
}

export interface MockContext {
    calls: RecordedCall[];
    uploads: number;
    /** Consultas al endpoint que dice si el archivo subido ya está ACTIVE. */
    statusPolls: number;
    /** Peticiones que incluyen el audio del fragmento `i` (0-indexado). */
    callsFor(index: number): RecordedCall[];
    uriOf(index: number): string;
    reset(): void;
}

// --------------------------------------------------------------- respuestas

/** Respuesta estándar de Gemini (JSON). */
export function geminiStream(text: string, opts: { finishReason?: string; tokens?: number } = {}): Response {
    const { finishReason = 'STOP', tokens = 500 } = opts;
    return new Response(JSON.stringify({
        candidates: [{
            content: { parts: [{ text }] },
            finishReason,
        }],
        usageMetadata: { candidatesTokenCount: tokens },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Respuesta SSE al estilo OpenAI, que es la que usa Groq.
 *
 * `finishReason` va en un último trozo sin texto, igual que lo manda la API:
 * `'length'` es su forma de decir que el modelo se quedó sin sitio para
 * escribir y que la respuesta está cortada.
 */
export function groqStream(text: string, opts: { finishReason?: string } = {}): Response {
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const line of text.split('\n')) {
                controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: line + '\n' } }] })}\n\n`));
            }
            if (opts.finishReason) {
                controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: opts.finishReason }] })}\n\n`));
            }
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
        },
    }), { status: 200 });
}

/** Stream que se corta a media respuesta (MAX_TOKENS). */
export function truncatedStream(text: string): Response {
    return new Response(JSON.stringify({
        candidates: [{
            content: { parts: [{ text }] },
            finishReason: 'MAX_TOKENS',
        }],
        usageMetadata: { candidatesTokenCount: 500 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export const apiError = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 429 por límite por minuto: la API sugiere cuánto esperar. */
export const rateLimit = (retryDelaySeconds = 2) => apiError(429, {
    error: {
        code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retryDelaySeconds}s` }],
    },
});

/** 429 por cuota DIARIA: esperar no sirve, hay que cambiar de modelo. */
export const dailyQuota = () => apiError(429, {
    error: {
        code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota per day',
        details: [{
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{
                quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            }],
        }],
    },
});

/** 503 / 500: servidor sobrecargado. */
export const overloaded = (status = 503) => apiError(status, {
    error: { code: status, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' },
});

export const badKey = () => apiError(400, {
    error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' },
});

export const badRequest = (message = 'Invalid argument') => apiError(400, {
    error: { code: 400, status: 'INVALID_ARGUMENT', message },
});

export const modelNotFound = () => apiError(404, {
    error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-x is not found for API version v1beta' },
});

/** Respuesta bloqueada por filtros de seguridad: 200 pero sin texto. */
export const safetyBlocked = () => {
    return new Response(JSON.stringify({
        candidates: [{ finishReason: 'SAFETY' }],
        promptFeedback: { blockReason: 'SAFETY' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
};

// ------------------------------------------------------------------ handler

export type Handler = (call: RecordedCall, ctx: MockContext) => Response | Promise<Response>;

class FakeXHR {
    static counter = 0;
    static failNext = false;
    upload: any = {};
    status = 200;
    responseText = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() { /* noop */ }
    setRequestHeader() { /* noop */ }
    send() {
        if (FakeXHR.failNext) {
            FakeXHR.failNext = false;
            setTimeout(() => this.onerror?.(), 0);
            return;
        }
        const n = ++FakeXHR.counter;
        const name = `files/upload${n}`;
        this.responseText = JSON.stringify({ file: { uri: name, name } });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 500, total: 1000 });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1000, total: 1000 });
        setTimeout(() => this.onload?.(), 0);
    }
}

/**
 * Instala los dobles de red. Devuelve el contexto con el registro de llamadas.
 *
 * `setTimeout` se acelera a propósito: los backoff reales llegan a 60 s y la
 * lógica de reintentos es justo lo que hay que probar, así que se conserva el
 * orden de las esperas pero no su duración.
 */
export function installMocks(handler: Handler): MockContext {
    const ctx: MockContext = {
        calls: [],
        uploads: 0,
        callsFor(index) { return this.calls.filter(c => c.uris.includes(this.uriOf(index))); },
        uriOf(index) { return `files/upload${index + 1}`; },
        statusPolls: 0,
        reset() { this.calls = []; this.uploads = 0; this.statusPolls = 0; FakeXHR.counter = 0; },
    };

    FakeXHR.counter = 0;
    FakeXHR.failNext = false;
    fileStatusHandler = null;
    (globalThis as any).XMLHttpRequest = FakeXHR;

    // Instalar dobles de red = empezar una ejecución nueva. La cuarentena de
    // modelos saturados vive en el módulo y, sin esto, el 503 de una prueba
    // dejaba al modelo apartado durante la siguiente.
    resetModelHealth();

    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: any, ms?: number, ...rest: any[]) =>
        realSetTimeout(fn, Math.min(ms ?? 0, 1), ...rest)) as any);

    vi.stubGlobal('fetch', async (input: any, init?: any): Promise<Response> => {
        const url = String(input);

        if (url.includes('/upload/v1beta/files')) {
            ctx.uploads++;
            return new Response('{}', { status: 200, headers: { 'X-Goog-Upload-URL': `https://upload.test/session/${ctx.uploads}` } });
        }
        if (url.includes('upload.test/session/')) {
            if (failNextUploadFlag) {
                failNextUploadFlag = false;
                throw new TypeError('Error de red al subir archivo');
            }
            const num = url.split('/').pop();
            return new Response(JSON.stringify({ file: { uri: `files/upload${num}`, name: `files/upload${num}` } }), { status: 200 });
        }
        if (url.includes('/v1beta/files/')) {
            ctx.statusPolls++;
            if (fileStatusHandler) return fileStatusHandler(ctx.statusPolls);
            return new Response(JSON.stringify({ state: 'ACTIVE' }), { status: 200 });
        }
        if (url.includes('/models?key=')) {
            return new Response(JSON.stringify({ models: [] }), { status: 200 });
        }

        const isGroq = url.includes('api.groq.com');
        const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;

        const call: RecordedCall = {
            url,
            model: isGroq ? (body?.model ?? 'whisper-large-v3-turbo') : (url.match(/models\/([^:]+):/)?.[1] ?? '?'),
            uris: body?.contents?.[0]?.parts?.filter((p: any) => p.fileData).map((p: any) => p.fileData.fileUri) ?? [],
            prompt: isGroq
                ? (body?.messages?.[0]?.content ?? '')
                : (body?.contents?.[0]?.parts?.find((p: any) => p.text)?.text ?? ''),
            body,
            provider: isGroq ? 'groq' : 'gemini',
        };
        ctx.calls.push(call);
        return handler(call, ctx);
    });

    return ctx;
}

let fileStatusHandler: ((poll: number) => Response) | null = null;

/**
 * Sustituye la respuesta de "¿ya está listo el archivo subido?".
 *
 * Recibe el número de consulta (1, 2, 3…) para poder simular una recuperación
 * a la tercera, o un fallo sostenido. `null` restaura el ACTIVE inmediato.
 */
export function stubFileStatus(fn: ((poll: number) => Response) | null) {
    fileStatusHandler = fn;
}

let failNextUploadFlag = false;

/** Fuerza el fallo de la próxima subida. */
export function failNextUpload() {
    FakeXHR.failNext = true;
    failNextUploadFlag = true;
}

// -------------------------------------------------------------- utilidades

/**
 * Transcripción sintética con timestamps cada 30 s, en el rango pedido.
 *
 * `tag` distingue el contenido de cada fragmento: sin él, los cuatro salen
 * idénticos y el deduplicador de solapes —con razón— borra el principio de
 * los siguientes por parecerse al final del anterior.
 */
const VOCABULARIO = [
    'criptografía', 'esteganografía', 'escítala', 'cifrado', 'clave', 'mensaje',
    'transposición', 'sustitución', 'frecuencia', 'alfabeto', 'romanos', 'espartanos',
    'metadatos', 'forense', 'binario', 'diccionario', 'polialfabético', 'criptograma',
    'seguridad', 'ingeniería', 'contraseña', 'ejercicio', 'ejemplo', 'pizarra',
];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

export function fakeTranscript(fromSec: number, toSec: number, tag = ''): string {
    let out = '';
    const base = Math.abs(hash(tag));
    for (let s = Math.floor(fromSec / 30) * 30; s < toSec; s += 30) {
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        // Frases de verdad distintas entre fragmentos: si todas se parecen
        // palabra por palabra, el deduplicador de solapes las toma —con
        // razón— por repetidas y borra el principio de cada fragmento.
        const palabras = Array.from({ length: 14 }, (_, i) =>
            VOCABULARIO[Math.abs(hash(`${tag}|${s}|${i}`) + base) % VOCABULARIO.length]).join(' ');
        out += `[${mm}:${ss}] ${palabras} en el segundo ${s}.\n`;
    }
    return out;
}

/** Transcripción distinta para cada fragmento, a partir de sus URIs. */
export const transcriptFor = (call: { uris: string[] }, from = 0, to = 1200) =>
    fakeTranscript(from, to, call.uris.join('-'));

/** Reproduce el bucle degenerado observado en producción ("no, no, no…"). */
export function repetitionLoop(repeats = 400): string {
    return `[09:48] Dicen, están caminando, ${'no, '.repeat(repeats)}`;
}

/**
 * Doble del recorte con FFmpeg, que en jsdom no existe (no hay
 * `SharedArrayBuffer` ni WASM que valga).
 *
 * Devuelve el registro de recortes pedidos: es lo que permite afirmar que un
 * rescate vuelve a pedir SÓLO el tramo estropeado y desde qué segundo.
 */
export function mockAudioSlicing(): { slices: { startSec: number; endSec?: number }[] } {
    const slices: { startSec: number; endSec?: number }[] = [];
    vi.doMock('../../src/lib/ffmpeg-chunker', () => ({
        isFFmpegSupported: () => true,
        sliceAudio: async (file: File, startSec: number, endSec?: number) => {
            slices.push({ startSec, endSec });
            return new File([new Uint8Array(500)], `${file.name}_from${Math.round(startSec)}s.m4a`, { type: 'audio/mp4' });
        },
    }));
    return { slices };
}

/** Deshace `mockAudioSlicing`: sin FFmpeg no hay rescate posible. */
export function restoreAudioSlicing() {
    vi.doUnmock('../../src/lib/ffmpeg-chunker');
}

export const audioFile = (name = 'clase.m4a', bytes = 1000) =>
    new File([new Uint8Array(bytes)], name, { type: 'audio/mp4' });

/** Cuatro fragmentos de 20 minutos, como los que produce el chunker real. */
export const fourChunks = () => ({
    files: [0, 1, 2, 3].map(i => audioFile(`clase_part${i}.m4a`)),
    metadata: [0, 1, 2, 3].map(i => ({ startTime: i * 1200, endTime: (i + 1) * 1200, index: i })),
    duration: 4800,
});

/** Cuenta los huecos señalados en un texto. */
export const countGaps = (text: string) => (text.match(/⚠️/g) || []).length;

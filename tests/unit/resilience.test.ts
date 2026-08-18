import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sanitizeDuration } from '../../src/lib/duration';
import { resolveTranscriptionModel } from '../../src/lib/providers';
import { beginRun, abortRun, sleep, fetchWithTimeout, isCancelledError, throwIfCancelled } from '../../src/lib/pipeline-control';
import { progress } from '../../src/lib/progress';
import { transcribeWithGeminiChunked } from '../../src/lib/gemini';
import { installMocks, geminiStream, fakeTranscript } from '../helpers/mock-gemini';

/**
 * Defensas contra el mundo exterior.
 *
 * Todo lo que hay aquí reproduce una forma concreta de colgarse o de morir sin
 * explicación que la app tuvo: duraciones imposibles, un proveedor al que se le
 * manda el modelo de otro, una cancelación que no cancelaba nada y una red que
 * acepta la conexión y luego se calla.
 */

describe('duraciones que el navegador no sabe medir', () => {
    it('convierte Infinity, NaN y negativos en 0 ("no se sabe")', () => {
        expect(sanitizeDuration(Infinity)).toBe(0);
        expect(sanitizeDuration(NaN)).toBe(0);
        expect(sanitizeDuration(-5)).toBe(0);
        expect(sanitizeDuration(undefined)).toBe(0);
        expect(sanitizeDuration(0)).toBe(0);
    });

    it('deja pasar una duración normal', () => {
        expect(sanitizeDuration(1234.5)).toBe(1234.5);
    });
});

/**
 * Un archivo que llega SIN trocear por tiempo.
 *
 * Aquí había un troceado por bytes que se inventaba los fragmentos, y estas
 * pruebas vigilaban su peor efecto: con una duración de Infinity salía a 0 bytes
 * por fragmento, `offset += 0`, y la pestaña moría llenando memoria. Ese
 * troceado ya no existe —cortar un MP3 o un WAV por bytes no produce audio, sólo
 * el primer trozo era válido—, así que lo que se vigila ahora es que la entrada
 * rara siga terminando: una petición, con el audio entero, y un aviso.
 */
describe('audio sin trocear por tiempo', () => {
    afterEach(() => vi.unstubAllGlobals());
    beforeEach(() => progress.resetIdle());

    /** 50 MB de MP3: un archivo grande y creíble, sin duración legible. */
    const bigFile = () => new File([new Uint8Array(50 * 1024 * 1024)], 'clase.mp3', { type: 'audio/mpeg' });

    it('termina en una sola petición cuando la duración llega como Infinity', async () => {
        const ctx = installMocks(() => geminiStream(fakeTranscript(0, 600)));

        const r = await transcribeWithGeminiChunked(bigFile(), 'KEY', undefined, Infinity);

        expect(ctx.calls).toHaveLength(1);
        expect(r.text.length).toBeGreaterThan(0);
    }, 30_000);

    it('termina también con duración 0', async () => {
        const ctx = installMocks(() => geminiStream(fakeTranscript(0, 600)));
        const r = await transcribeWithGeminiChunked(bigFile(), 'KEY', undefined, 0);

        expect(ctx.calls).toHaveLength(1);
        expect(r.text.length).toBeGreaterThan(0);
    }, 30_000);

    it('avisa de que el audio va entero y puede quedarse corto', async () => {
        installMocks(() => geminiStream(fakeTranscript(0, 600)));
        await transcribeWithGeminiChunked(bigFile(), 'KEY', undefined, Infinity);

        const avisos = progress.getSnapshot().events.filter(e => e.kind === 'warn');
        expect(avisos.some(e => /trocear|split/i.test(e.text))).toBe(true);
    }, 30_000);
});

describe('modelo elegido y proveedor activo', () => {
    it('descarta un modelo de Gemini cuando el proveedor es Groq', () => {
        expect(resolveTranscriptionModel('groq', 'gemini-3.7-flash')).toBe('auto');
    });

    it('descarta un modelo de Groq cuando el proveedor es Gemini', () => {
        expect(resolveTranscriptionModel('gemini', 'whisper-large-v3')).toBe('auto');
    });

    it('conserva el modelo cuando sí pertenece al proveedor', () => {
        expect(resolveTranscriptionModel('gemini', 'gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite');
        expect(resolveTranscriptionModel('groq', 'whisper-large-v3')).toBe('whisper-large-v3');
    });

    /**
     * Transcribir es cosa de los Flash Lite. Un Flash guardado de una versión
     * anterior en localStorage no puede colarse en un flujo de doce
     * fragmentos: son 20 peticiones al día.
     */
    it('descarta un Flash guardado de antes: transcribir es cosa de los Lite', () => {
        expect(resolveTranscriptionModel('gemini', 'gemini-3.7-flash')).toBe('auto');
    });

    it('trata auto y los valores vacíos como auto', () => {
        expect(resolveTranscriptionModel('groq', 'auto')).toBe('auto');
        expect(resolveTranscriptionModel('groq', '')).toBe('auto');
        expect(resolveTranscriptionModel('gemini', null)).toBe('auto');
    });
});

describe('cancelación', () => {
    afterEach(() => { abortRun(); vi.unstubAllGlobals(); });

    it('despierta una espera larga en lugar de dejarla correr', async () => {
        beginRun();
        // Un backoff de 60 s mantenía viva la cancelación durante todo ese rato.
        const pending = sleep(60_000);
        abortRun();
        await expect(pending).rejects.toSatisfy(isCancelledError);
    });

    it('corta el proceso en el siguiente punto de control', () => {
        beginRun();
        expect(() => throwIfCancelled()).not.toThrow();
        abortRun();
        expect(() => throwIfCancelled()).toThrow();
    });

    it('sigue constando como cancelado después de abortar', () => {
        // Si la señal se descartara al cancelar, los puntos de control entre
        // etapas volverían a decir "todo en orden" y el flujo continuaría.
        beginRun();
        abortRun();
        expect(() => throwIfCancelled()).toThrow();
        expect(() => throwIfCancelled()).toThrow();
    });

    it('una ejecución nueva parte de cero', async () => {
        beginRun();
        abortRun();
        beginRun();
        vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
        await expect(fetchWithTimeout('https://ejemplo.test/x')).resolves.toBeInstanceOf(Response);
    });
});

describe('red que acepta la conexión y luego calla', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('deja de esperar y lo dice, en vez de colgarse para siempre', async () => {
        beginRun();
        vi.stubGlobal('fetch', (_url: any, init: any) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                const e = new Error('The operation was aborted');
                e.name = 'AbortError';
                reject(e);
            });
        }));

        await expect(
            fetchWithTimeout('https://ejemplo.test/lento', {}, { timeoutMs: 30, label: 'El servidor' })
        ).rejects.toThrow(/no respondió/);
    });
});

describe('barra de progreso con datos imposibles', () => {
    beforeEach(() => progress.resetIdle());

    it('no publica NaN aunque la duración llegue como Infinity', () => {
        progress.start({
            provider: 'gemini',
            fileName: 'clase.m4a',
            fileSize: 30 * 1024 * 1024,
            durationSeconds: Infinity,
            stages: ['prepare', 'transcribe', 'organize'],
        });
        progress.beginStage('prepare');
        progress.setStage('prepare', 0.5);

        const s = progress.getSnapshot();
        expect(Number.isFinite(s.global)).toBe(true);
        expect(s.global).toBeGreaterThan(0);
        expect(s.counters.audioTotalSec).toBe(0);
        expect(s.stages.every(st => Number.isFinite(st.expectedMs))).toBe(true);
    });

    it('ignora un progreso de etapa no finito', () => {
        progress.start({
            provider: 'groq', fileName: 'a.mp3', fileSize: 1000,
            durationSeconds: 600, stages: ['prepare', 'transcribe'],
        });
        progress.beginStage('transcribe');
        progress.setStage('transcribe', NaN);
        expect(Number.isFinite(progress.getSnapshot().global)).toBe(true);
    });
});

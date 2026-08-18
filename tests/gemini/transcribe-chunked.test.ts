import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { transcribeWithGeminiChunked, MAX_RETRIES_PER_MODEL, maxParallelChunks } from '../../src/lib/gemini';
import { progress } from '../../src/lib/progress';
import {
    installMocks, geminiStream, fakeTranscript, repetitionLoop, fourChunks,
    overloaded, badRequest, dailyQuota, countGaps, type RecordedCall,
} from '../helpers/mock-gemini';

/**
 * Ruta fragmentada. Aquí vivían los fallos reales observados: un fragmento que
 * se quedaba a la mitad, otro que moría por "high demand", y el conjunto
 * perdiéndose entero por un `Promise.all`.
 */
describe('transcripción por fragmentos', () => {
    const { files, metadata, duration } = fourChunks();
    const run = () => transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata);
    const startPoint = (c: RecordedCall) => c.prompt.match(/exactly at \[([\d:]+)\]/)?.[1] ?? null;

    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    describe('camino feliz', () => {
        it('una petición por fragmento y el texto ensamblado en orden', async () => {
            const ctx = installMocks(() => geminiStream(fakeTranscript(0, 1200)));
            const r = await run();

            expect(ctx.calls).toHaveLength(4);
            expect(ctx.uploads).toBe(4);
            expect(countGaps(r.text)).toBe(0);
            expect(r.tokensUsed).toBeGreaterThan(0);
        });

        it('desplaza los timestamps de cada fragmento a tiempo absoluto', async () => {
            installMocks(() => geminiStream(fakeTranscript(0, 1200)));
            const r = await run();

            // El cuarto fragmento empieza en el minuto 60 del audio original.
            expect(r.text).toContain('[00:00]');
            expect(r.text).toMatch(/\[01:0\d:\d\d\]/);
        });

        it('inicializa el tablero de fragmentos del progreso', async () => {
            installMocks(() => geminiStream(fakeTranscript(0, 1200)));
            await run();
            const s = progress.getSnapshot();
            expect(s.chunks).toHaveLength(4);
            expect(s.chunks.every(c => c.status === 'done')).toBe(true);
        });
    });

    describe('un fragmento se queda a la mitad', () => {
        it('señala el corte por límite de tokens en ese fragmento', async () => {
            const ctx = installMocks((c, x) => {
                if (c.uris.includes(x.uriOf(0))) {
                    return geminiStream(fakeTranscript(0, 600), { finishReason: 'MAX_TOKENS' });
                }
                return geminiStream(fakeTranscript(0, 1200));
            });

            const r = await run();

            expect(ctx.callsFor(0)).toHaveLength(1);
            expect(ctx.callsFor(1)).toHaveLength(1);
            expect(ctx.callsFor(2)).toHaveLength(1);
            expect(ctx.callsFor(3)).toHaveLength(1);
            expect(r.text).toContain('límite de tokens');
        });
    });

    describe('un fragmento falla del todo', () => {
        it('conserva los demás en lugar de perderlo todo', async () => {
            const ctx = installMocks((c, x) =>
                c.uris.includes(x.uriOf(2)) ? badRequest('Audio corrupto') : geminiStream(fakeTranscript(0, 1200)));

            const r = await run();

            expect(r.text).toContain('[00:00]');
            expect(countGaps(r.text)).toBe(1);
            expect(r.text).toContain('Audio corrupto');
            expect(ctx.callsFor(0)).toHaveLength(1);
            expect(ctx.callsFor(1)).toHaveLength(1);
            expect(ctx.callsFor(3)).toHaveLength(1);
        });

        it('el hueco lleva el rango temporal exacto que falta', async () => {
            installMocks((c, x) =>
                c.uris.includes(x.uriOf(2)) ? badRequest() : geminiStream(fakeTranscript(0, 1200)));
            const r = await run();
            // Sin corchetes a propósito: el aviso convive con la transcripción,
            // y lo que cose los fragmentos busca marcas `[MM:SS]` para saber
            // qué tiempo cubre cada línea. Un aviso entre corchetes se leía
            // como texto transcrito y se colaba con el tiempo cambiado.
            expect(r.text).toContain('Falta el audio de 40:00 a 01:00:00');
        });

        it('sólo lanza error si no se salvó ningún fragmento', async () => {
            installMocks(() => badRequest('API Key inválida'));
            await expect(run()).rejects.toThrow(/API Key inválida|Invalid argument/);
        });
    });

    describe('resiliencia y fallback', () => {
        /**
         * Cuando un fragmento descubre que el primer modelo está saturado, los
         * siguientes arrancan directamente por el que sí responde en vez de
         * volver a estrellarse contra el mismo.
         */
        it('los fragmentos comparten el modelo que sí responde', async () => {
            const ctx = installMocks((c) =>
                c.model === 'gemini-3.5-flash-lite' ? overloaded() : geminiStream(fakeTranscript(0, 1200)));
            const r = await run();

            expect(r.text).toContain('[00:00]');
            expect(countGaps(r.text)).toBe(0);

            // En serie, el primer fragmento paga el descubrimiento y el resto
            // arranca ya por el modelo bueno.
            ctx.reset();
            await transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata, undefined, 1);
            const fallidas = ctx.calls.filter(c => c.model === 'gemini-3.5-flash-lite').length;
            expect(fallidas).toBeLessThanOrEqual(MAX_RETRIES_PER_MODEL);
        });

        /**
         * La simultaneidad la elige el usuario, pero el techo lo pone el free
         * tier: 15 RPM y 250K TPM. Pedir doce a la vez con fragmentos de 20
         * minutos no es ir más rápido, es un 429 garantizado.
         */
        it('nunca lanza más fragmentos a la vez de los que caben en la cuota', async () => {
            let vivos = 0;
            let pico = 0;
            const ctx = installMocks(async () => {
                vivos++;
                pico = Math.max(pico, vivos);
                await new Promise(r => setTimeout(r, 5));
                vivos--;
                return geminiStream(fakeTranscript(0, 1200));
            });

            await transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata, undefined, 12);

            expect(ctx.calls).toHaveLength(4);
            expect(pico).toBeLessThanOrEqual(maxParallelChunks('gemini-3.5-flash-lite', 1200));
        });

        it('limpia los bucles de repetición dentro de un fragmento', async () => {
            installMocks((c, x) => {
                if (c.uris.includes(x.uriOf(0))) {
                    return geminiStream(fakeTranscript(0, 580) + repetitionLoop(400));
                }
                return geminiStream(fakeTranscript(0, 1200));
            });

            const r = await run();

            expect(r.text).not.toMatch(/no, no, no, no, no, no/);
            expect(r.text).toContain('repetición del modelo omitida');
        });
    });
});

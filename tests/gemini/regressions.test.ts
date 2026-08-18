import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { transcribeWithGeminiChunked, transcribeWithGemini } from '../../src/lib/gemini';
import { stripRepetitionRuns } from '../../src/lib/text-cleanup';
import { progress } from '../../src/lib/progress';
import {
    installMocks, geminiStream, fakeTranscript, transcriptFor, repetitionLoop,
    fourChunks, audioFile, overloaded, countGaps, mockAudioSlicing, restoreAudioSlicing,
    type RecordedCall,
} from '../helpers/mock-gemini';

/**
 * Regresiones: cada caso reproduce un fallo observado de verdad en la app, no
 * uno imaginado. Si alguno vuelve a romperse, aquí se entera antes que el
 * usuario.
 */
describe('regresiones de fallos observados', () => {
    const { files, metadata, duration } = fourChunks();
    const run = () => transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata);

    beforeEach(() => progress.resetIdle());
    afterEach(() => {
        vi.unstubAllGlobals();
        restoreAudioSlicing();
    });

    describe('PDF "errorNo": diez páginas de "no, no, no" y diez minutos perdidos', () => {
        /**
         * Lo ocurrido: el fragmento 1 se enganchó en [09:48] repitiendo "no, "
         * hasta agotar los 32K tokens, la limpieza de entonces no lo detectaba
         * (exigía separación por espacios y sólo miraba el final del texto), y
         * el documento salió con el bucle dentro y sin los minutos 10 a 20.
         */
        it('la racha separada por comas SÍ se detecta', () => {
            const documento = fakeTranscript(0, 588) + repetitionLoop(7000);
            const { text, removed } = stripRepetitionRuns(documento);

            expect(removed).toBeGreaterThan(25_000);
            expect(text.match(/no, no, no, no/)).toBeNull();
        });

        it('el bucle a mitad del texto también, no sólo al final', () => {
            const documento = fakeTranscript(0, 300) + repetitionLoop(2000) + fakeTranscript(1200, 1500);
            const { removed } = stripRepetitionRuns(documento);

            expect(removed).toBeGreaterThan(5_000);
            expect(stripRepetitionRuns(documento).text).toContain('[20:00]');
        });

        it('se corta en caliente en vez de quemar el presupuesto entero', async () => {
            let bytesGenerados = 0;
            installMocks(() => {
                const cuerpo = fakeTranscript(0, 588) + repetitionLoop(7000);
                bytesGenerados += cuerpo.length;
                return geminiStream(cuerpo);
            });

            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);
            // El texto que sobrevive es una fracción de lo que el modelo emitió.
            expect(r.text.length).toBeLessThan(bytesGenerados / 3);
            expect(r.text).toContain('[09:30]');
        });

        it('el hueco queda señalado con el minuto exacto', async () => {
            // Sin FFmpeg (jsdom) no hay recorte que reintentar, así que el
            // tramo perdido se dice: es lo que faltaba en aquel PDF, que
            // terminaba sin más y parecía completo.
            installMocks(() => geminiStream(fakeTranscript(0, 588) + repetitionLoop(7000)));
            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

            expect(r.text).toContain('falta el audio de 09:48 a 20:00');
        });

        it('los diez minutos perdidos se recuperan reintentando sólo ese tramo', async () => {
            const { slices } = mockAudioSlicing();
            let n = 0;
            const ctx = installMocks(() => (++n === 1
                ? geminiStream(fakeTranscript(0, 588) + repetitionLoop(7000))
                : geminiStream(fakeTranscript(0, 612, 'cola'))));

            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

            expect(slices).toEqual([{ startSec: 588, endSec: 1200 }]);
            expect(ctx.calls).toHaveLength(2);
            // Los minutos 10 a 20 que aquel documento no tenía.
            expect(r.text).toContain('[19:48]');
            expect(countGaps(r.text)).toBe(0);
        });
    });

    describe('la tanda de 4 fragmentos: uno a medias, otro por "high demand"', () => {
        /**
         * Lo ocurrido: se mandaron 4 fragmentos, el primero degeneró a la mitad
         * y falló por saturación, los otros tres terminaron, y el conjunto se
         * perdía porque un `Promise.all` rechazaba con el primero que fallara.
         */
        it('los fragmentos buenos sobreviven al fallo del malo', async () => {
            const ctx = installMocks((c, x) =>
                c.uris.includes(x.uriOf(0)) ? overloaded() : geminiStream(transcriptFor(c)));

            const r = await run();

            // Tres cuartas partes del audio siguen ahí.
            expect(r.text).toContain('[20:00]');
            expect(r.text).toContain('[40:00]');
            expect(countGaps(r.text)).toBe(1);
            expect(ctx.callsFor(1)).toHaveLength(1);
        });

        it('no se reintenta ningún fragmento que ya estaba bien', async () => {
            const ctx = installMocks((c, x) =>
                c.uris.includes(x.uriOf(0)) ? overloaded() : geminiStream(fakeTranscript(0, 1200)));
            await run();

            for (const i of [1, 2, 3]) expect(ctx.callsFor(i)).toHaveLength(1);
        });

        it('la saturación no dispara una tormenta infinita de peticiones', async () => {
            const ctx = installMocks(() => overloaded());
            await expect(run()).rejects.toThrow();

            expect(ctx.calls.length).toBeLessThanOrEqual(144);
        });
    });

    describe('el progreso no puede aparentar estar colgado', () => {
        it('una espera por saturación se anuncia con su motivo', async () => {
            // Dos 503 seguidos, no uno: el primero se lo come la sonda sin
            // streaming, que comprueba si lo que falla es el modelo o sólo esa
            // ruta. Con un único 503 la sonda encuentra el modelo sano y
            // responde al momento — no hay espera, y no hay nada que anunciar.
            // La espera de verdad empieza cuando también falla la sonda.
            let n = 0;
            installMocks(() => (++n <= 2 ? overloaded() : geminiStream(fakeTranscript(0, 600))));
            await transcribeWithGemini(audioFile(), 'KEY', undefined, 600);

            const eventos = progress.getSnapshot().events;
            expect(eventos.some(e => e.kind === 'retry' && /Overloaded|saturado|Límite/i.test(e.text))).toBe(true);
        }, 20_000);
    });
});

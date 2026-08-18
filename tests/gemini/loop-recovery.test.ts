import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { transcribeWithGemini } from '../../src/lib/gemini';
import { progress } from '../../src/lib/progress';
import {
    installMocks, geminiStream, fakeTranscript, repetitionLoop, audioFile,
    mockAudioSlicing, restoreAudioSlicing, countGaps,
} from '../helpers/mock-gemini';

/**
 * Rescate de un modelo atascado repitiendo.
 *
 * El bucle ya se detectaba y se cortaba el stream; lo que se perdía era todo el
 * audio que quedaba DETRÁS del atasco — hasta veinte minutos de clase por
 * fragmento, sin que nada lo dijera. Aquí se comprueba lo que hace ahora: se
 * conserva lo transcrito antes, se recorta el audio desde el segundo del atasco
 * y sólo eso se vuelve a pedir.
 *
 * `repetitionLoop()` empieza con la marca [09:48], así que ése es el punto de
 * reanudación esperado en todos los casos.
 */
describe('rescate de un bucle de repetición', () => {
    beforeEach(() => progress.resetIdle());
    afterEach(() => {
        vi.unstubAllGlobals();
        restoreAudioSlicing();
    });

    const atascado = () => geminiStream(fakeTranscript(0, 588) + repetitionLoop(400));

    it('reintenta SÓLO el audio que va desde el atasco hasta el final', async () => {
        const { slices } = mockAudioSlicing();
        let n = 0;
        const ctx = installMocks(() => (++n === 1 ? atascado() : geminiStream(fakeTranscript(0, 600, 'cola'))));

        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

        // Un solo recorte, desde el segundo del atasco hasta el final.
        expect(slices).toEqual([{ startSec: 588, endSec: 1200 }]);
        expect(ctx.calls).toHaveLength(2);
        // Y el recorte es lo que viaja en la segunda petición: no el fragmento entero.
        expect(ctx.calls[1].uris).not.toEqual(ctx.calls[0].uris);
    });

    it('conserva lo bueno de antes y pega la cola en su minuto real', async () => {
        mockAudioSlicing();
        let n = 0;
        installMocks(() => (++n === 1 ? atascado() : geminiStream(fakeTranscript(0, 600, 'cola'))));

        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

        expect(r.text).toContain('[09:30]');              // lo transcrito antes del atasco
        expect(r.text).not.toMatch(/no, no, no, no/);     // el bucle no llega al documento
        expect(r.text).not.toContain('están caminando');  // el segmento estropeado se descarta
        expect(r.text).toContain('[09:48]');              // la cola arranca donde se atascó
        expect(r.text).toContain('[19:18]');              // …y llega hasta el final (09:48 + 09:30)
        expect(countGaps(r.text)).toBe(0);
    });

    it('no toca nada cuando el modelo no se atasca', async () => {
        const { slices } = mockAudioSlicing();
        const ctx = installMocks(() => geminiStream(fakeTranscript(0, 1200)));

        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

        expect(ctx.calls).toHaveLength(1);
        expect(slices).toHaveLength(0);
        expect(countGaps(r.text)).toBe(0);
    });

    it('se rinde tras dos rescates y deja el hueco señalado', async () => {
        const { slices } = mockAudioSlicing();
        const ctx = installMocks(() => atascado());

        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 4800);

        // Una petición y dos rescates: no se insiste indefinidamente contra un
        // audio que atasca al modelo una y otra vez.
        expect(ctx.calls).toHaveLength(3);
        expect(slices.map(s => s.startSec)).toEqual([588, 1176]);
        expect(r.text).toContain('falta el audio de 29:24');
        expect(countGaps(r.text)).toBe(1);
    });

    it('sin FFmpeg no hay recorte: se señala el hueco en vez de perderlo en silencio', async () => {
        // Sin `mockAudioSlicing`, `isFFmpegSupported()` es false en jsdom.
        const ctx = installMocks(() => atascado());

        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

        expect(ctx.calls).toHaveLength(1);
        expect(r.text).toContain('[09:30]');
        expect(r.text).toContain('falta el audio de 09:48 a 20:00');
    });

    it('si el rescate se queda sin respuesta, el hueco se dice', async () => {
        mockAudioSlicing();
        let n = 0;
        installMocks(() => (++n === 1 ? atascado() : geminiStream('')));

        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

        // Lo transcrito antes del atasco se conserva; lo que no llegó, se avisa.
        expect(r.text).toContain('[09:30]');
        expect(r.text).toContain('falta el audio de 09:48 a 20:00');
    });

    it('no reintenta por una cola de segundos', async () => {
        const { slices } = mockAudioSlicing();
        const ctx = installMocks(() => atascado());

        // El atasco cae en [09:48] de un audio de 9:58: no queda nada que rescatar.
        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 598);

        expect(ctx.calls).toHaveLength(1);
        expect(slices).toHaveLength(0);
        expect(r.text).toContain('[09:30]');
    });
});

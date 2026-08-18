import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { transcribeWithGemini } from '../../src/lib/gemini';
import { progress } from '../../src/lib/progress';
import {
    installMocks, geminiStream, fakeTranscript, repetitionLoop, audioFile,
    truncatedStream, safetyBlocked, countGaps,
} from '../helpers/mock-gemini';

/** Ruta estándar: audio de menos de 20 minutos, una sola petición. */
describe('transcripción estándar (sin fragmentar)', () => {
    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    describe('camino feliz', () => {
        it('devuelve el texto, los tokens y sube el audio una sola vez', async () => {
            const ctx = installMocks(() => geminiStream(fakeTranscript(0, 600), { tokens: 1234 }));
            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 600);

            expect(r.text).toContain('[00:00]');
            expect(r.text).toContain('[09:30]');
            expect(r.tokensUsed).toBe(1234);
            expect(ctx.uploads).toBe(1);
            expect(ctx.calls).toHaveLength(1);
        });

        it('pide la transcripción en streaming', async () => {
            const ctx = installMocks(() => geminiStream(fakeTranscript(0, 300)));
            await transcribeWithGemini(audioFile(), 'KEY', undefined, 300);
            // Streaming: sin esto el fragmento pasa de 0 a 100 de golpe,
            // porque no hay ninguna señal intermedia que publicar.
            expect(ctx.calls[0].url).toContain(':streamGenerateContent');
            expect(ctx.calls[0].url).toContain('alt=sse');
        });

        it('publica progreso en el callback onProgress', async () => {
            installMocks(() => geminiStream(fakeTranscript(0, 600)));
            const vistos: number[] = [];
            await transcribeWithGemini(audioFile(), 'KEY', (p) => vistos.push(p), 600);

            expect(vistos.length).toBeGreaterThan(2);
            // Monótono y terminando en 1.
            expect(vistos).toEqual([...vistos].sort((a, b) => a - b));
            expect(vistos[vistos.length - 1]).toBe(1);
        });

        it('el presupuesto de tokens es proporcional a la duración', async () => {
            const ctx = installMocks(() => geminiStream(fakeTranscript(0, 300)));
            await transcribeWithGemini(audioFile(), 'KEY', undefined, 300);
            const budget = ctx.calls[0].body.generationConfig.maxOutputTokens;
            // 5 minutos no justifican el techo de 32K del modelo.
            expect(budget).toBeLessThan(10_000);
            expect(budget).toBeGreaterThan(3_000);
        });

        it('normaliza el mime de los m4a, que Gemini rechaza', async () => {
            const ctx = installMocks(() => geminiStream(fakeTranscript(0, 60)));
            const file = new File([new Uint8Array(10)], 'a.m4a', { type: 'audio/x-m4a' });
            await transcribeWithGemini(file, 'KEY', undefined, 60);
            expect(ctx.calls[0].body.contents[0].parts[0].fileData.mimeType).toBe('audio/mp4');
        });

        it('limpia los espacios que el modelo mete dentro del timestamp', async () => {
            installMocks(() => geminiStream('[ 00:13:19] texto de la clase con longitud suficiente'));
            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 800);
            expect(r.text).toContain('[00:13:19]');
        });
    });

    describe('transcripción incorrecta o incompleta', () => {
        it('limpia cuando el modelo entra en bucle de repetición', async () => {
            installMocks(() => geminiStream(fakeTranscript(0, 300) + repetitionLoop(400)));
            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 600);

            expect(r.text).not.toMatch(/no, no, no, no, no, no/);
            expect(r.text).toContain('repetición del modelo omitida');
        });

        it('marca el corte por límite de tokens indicando DÓNDE se quedó', async () => {
            installMocks(() => geminiStream(fakeTranscript(0, 600), { finishReason: 'MAX_TOKENS' }));
            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 1200);

            // Sin corchetes: ver la nota del mismo aviso en transcribe-chunked.
            expect(r.text).toContain('Falta el audio a partir de 09:30');
            expect(r.text).toContain('límite de tokens');
        });

        it('falla claro si el modelo no devuelve nada', async () => {
            installMocks(() => geminiStream('', { finishReason: 'STOP' }));
            await expect(transcribeWithGemini(audioFile(), 'KEY', undefined, 600))
                .rejects.toThrow(/No se generó transcripción/);
        });

        it('falla indicando el motivo cuando lo bloquea el filtro de seguridad', async () => {
            installMocks(() => safetyBlocked());
            await expect(transcribeWithGemini(audioFile(), 'KEY', undefined, 600))
                .rejects.toThrow(/SAFETY/);
        });

        it('aprovecha lo recibido si el stream se corta a media respuesta', async () => {
            installMocks(() => truncatedStream(fakeTranscript(0, 300)));
            const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 600);
            expect(r.text).toContain('[04:30]');
        });

        it('estima la duración cuando no se la pasan', async () => {
            const ctx = installMocks(() => geminiStream(fakeTranscript(0, 300)));
            await transcribeWithGemini(audioFile('x.m4a', 5 * 1024 * 1024), 'KEY');
            // 5 MB → ~5 min estimados → presupuesto acorde, no el máximo.
            expect(ctx.calls[0].body.generationConfig.maxOutputTokens).toBeLessThan(10_000);
        });
    });
});

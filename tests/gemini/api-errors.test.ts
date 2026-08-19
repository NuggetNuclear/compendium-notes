import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { transcribeWithGemini, validateGeminiKey, GEMINI_MODEL_CHAIN } from '../../src/lib/gemini';
import { progress } from '../../src/lib/progress';
import {
    installMocks, failNextUpload, geminiStream, fakeTranscript, audioFile,
    rateLimit, dailyQuota, overloaded, badKey, badRequest, modelNotFound,
    stubFileStatus,
} from '../helpers/mock-gemini';

/**
 * Catálogo de errores reales de la API de Gemini.
 * La distinción que importa: qué se reintenta, qué cambia de modelo y qué
 * falla en el acto. Reintentar una key inválida es tan malo como rendirse
 * ante una saturación pasajera.
 */
describe('errores de la API de Gemini', () => {
    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    const transcribir = () => transcribeWithGemini(audioFile(), 'KEY', undefined, 600);

    describe('errores definitivos: fallan a la primera, sin gastar reintentos', () => {
        it('403 · API Key inválida', async () => {
            const ctx = installMocks(() => badKey());
            await expect(transcribir()).rejects.toThrow(/API key not valid/);
            expect(ctx.calls).toHaveLength(1);
        });

        it('400 · petición inválida (mime no soportado)', async () => {
            const ctx = installMocks(() => badRequest('Invalid audio mime type'));
            await expect(transcribir()).rejects.toThrow(/Invalid audio mime type/);
            expect(ctx.calls).toHaveLength(1);
        });

        it('404 · modelo inexistente', async () => {
            const ctx = installMocks(() => modelNotFound());
            await expect(transcribir()).rejects.toThrow(/is not found/);
            expect(ctx.calls).toHaveLength(1);
        });
    });

    describe('429 · límite por minuto (RPM/TPM)', () => {
        it('respeta el retryDelay que manda la propia API', async () => {
            let n = 0;
            const ctx = installMocks(() => (++n === 1 ? rateLimit(2) : geminiStream(fakeTranscript(0, 300))));
            const r = await transcribir();

            expect(r.text).toContain('[00:00]');
            expect(ctx.calls).toHaveLength(2);
            // Reintenta el MISMO modelo: el límite por minuto es pasajero.
            expect(ctx.calls[0].model).toBe(ctx.calls[1].model);
        });

        it('lo anuncia en el registro de actividad con la cuenta atrás', async () => {
            let n = 0;
            installMocks(() => (++n === 1 ? rateLimit(3) : geminiStream(fakeTranscript(0, 300))));
            await transcribir();

            const eventos = progress.getSnapshot().events;
            expect(eventos.some(e => e.kind === 'retry')).toBe(true);
        });

        it('cambia de modelo si insiste', async () => {
            let n = 0;
            const ctx = installMocks(() => (++n <= 3 ? rateLimit(1) : geminiStream(fakeTranscript(0, 300))));
            await transcribir();

            const modelos = [...new Set(ctx.calls.map(c => c.model))];
            expect(modelos.length).toBeGreaterThan(1);
            expect(modelos[0]).toBe(GEMINI_MODEL_CHAIN[0]);
        });
    });

    describe('429 · cuota diaria agotada (RPD)', () => {
        it('no espera: salta directamente al siguiente modelo', async () => {
            const ctx = installMocks((c) =>
                c.model === GEMINI_MODEL_CHAIN[0] ? dailyQuota() : geminiStream(fakeTranscript(0, 300)));
            const r = await transcribir();

            expect(r.text).toContain('[00:00]');
            // Un solo intento contra el modelo agotado: esperar no arregla una cuota diaria.
            expect(ctx.calls.filter(c => c.model === GEMINI_MODEL_CHAIN[0])).toHaveLength(1);
            expect(ctx.calls[1].model).toBe(GEMINI_MODEL_CHAIN[1]);
        });

        it('mensaje explícito si TODOS los modelos han agotado su cuota diaria', async () => {
            installMocks(() => dailyQuota());
            await expect(transcribir()).rejects.toThrow(/cuota diaria/i);
        });

        /**
         * El RPD agotado es un hecho de la CUENTA, no de la llamada. Se guardaba
         * en un `Set` local de `geminiGenerateWithFallback`, así que cada
         * fragmento volvía a descubrirlo por su cuenta: con seis fragmentos en
         * paralelo, seis peticiones y seis 429 para averiguar lo mismo.
         */
        it('lo aprendido sobre el RPD vale para el resto de la ejecución', async () => {
            const ctx = installMocks((c) =>
                c.model === GEMINI_MODEL_CHAIN[0] ? dailyQuota() : geminiStream(fakeTranscript(0, 300)));

            await transcribir();
            const trasLaPrimera = ctx.calls.filter(c => c.model === GEMINI_MODEL_CHAIN[0]).length;
            await transcribir();

            // La segunda transcripción ya no vuelve a picar contra el modelo sin
            // cuota: arranca directamente en el que sí responde.
            expect(ctx.calls.filter(c => c.model === GEMINI_MODEL_CHAIN[0])).toHaveLength(trasLaPrimera);
            expect(ctx.calls.at(-1)!.model).toBe(GEMINI_MODEL_CHAIN[1]);
        });

        it('lo cuenta en el registro con el modelo afectado', async () => {
            installMocks((c) =>
                c.model === GEMINI_MODEL_CHAIN[0] ? dailyQuota() : geminiStream(fakeTranscript(0, 300)));
            await transcribir();
            const textos = progress.getSnapshot().events.map(e => e.text).join(' | ');
            expect(textos).toMatch(/Cuota diaria/i);
        });
    });

    describe('5xx · saturación del servicio ("high demand")', () => {
        it.each([500, 502, 503, 504])('%i se reintenta y acaba saliendo adelante', async (status) => {
            let n = 0;
            const ctx = installMocks(() => (++n === 1 ? overloaded(status) : geminiStream(fakeTranscript(0, 300))));
            const r = await transcribir();
            expect(r.text).toContain('[00:00]');
            expect(ctx.calls.length).toBeGreaterThanOrEqual(2);
        });

        it('recorre la cadena de Flash Lite hasta encontrar uno disponible', async () => {
            const ctx = installMocks((c) =>
                c.model === GEMINI_MODEL_CHAIN[0] ? overloaded() : geminiStream(fakeTranscript(0, 300)));
            const r = await transcribir();

            expect(r.text).toContain('[00:00]');
            expect(ctx.calls[ctx.calls.length - 1].model).toBe(GEMINI_MODEL_CHAIN[1]);
        });

        /**
         * La cuota que protege esta prueba: los Flash admiten VEINTE peticiones
         * al día. Un audio largo son doce fragmentos. Si la transcripción
         * pudiera caer a un Flash cuando los Lite se saturan, dos audios
         * dejarían la cuenta sin modelos hasta el día siguiente.
         */
        it('nunca gasta un Flash en transcribir, aunque los Lite estén saturados', async () => {
            const ctx = installMocks(() => overloaded());
            await expect(transcribir()).rejects.toThrow();

            const modelos = [...new Set(ctx.calls.map(c => c.model))];
            expect(modelos.every(m => m.includes('lite'))).toBe(true);
        });

        it('mensaje claro si toda la cadena está saturada', async () => {
            installMocks(() => overloaded());
            await expect(transcribir()).rejects.toThrow(/saturados|límite de peticiones/i);
        });

        it('no se pasa de un puñado de peticiones aunque todo falle', async () => {
            const ctx = installMocks(() => overloaded());
            await expect(transcribir()).rejects.toThrow();
            expect(ctx.calls.length).toBeLessThanOrEqual(36);
        });
    });

    describe('fallos de red', () => {
        it('reintenta cuando fetch revienta sin respuesta HTTP', async () => {
            let n = 0;
            const ctx = installMocks(() => {
                if (++n === 1) throw new TypeError('Failed to fetch');
                return geminiStream(fakeTranscript(0, 300));
            });
            const r = await transcribir();
            expect(r.text).toContain('[00:00]');
            expect(ctx.calls).toHaveLength(2);
        });

        it('avisa en el registro', async () => {
            let n = 0;
            installMocks(() => {
                if (++n === 1) throw new TypeError('Failed to fetch');
                return geminiStream(fakeTranscript(0, 300));
            });
            await transcribir();
            expect(progress.getSnapshot().events.some(e => /red/i.test(e.text))).toBe(true);
        });
    });

    describe('errores de subida (Files API)', () => {
        it('se recupera de un corte de red puntual al subir los bytes', async () => {
            // Un parpadeo de red no puede costar el audio entero: se reintenta.
            installMocks(() => geminiStream(fakeTranscript(0, 300)));
            failNextUpload();
            const r = await transcribir();
            expect(r.text.length).toBeGreaterThan(0);
        });

        it('propaga el fallo de red cuando la subida no se recupera', async () => {
            installMocks(() => geminiStream(fakeTranscript(0, 300)));
            // Todas las subidas caen: agotados los intentos, el error sube.
            vi.stubGlobal('fetch', async (input: any) => {
                const url = String(input);
                if (url.includes('/upload/v1beta/files')) {
                    return new Response('{}', {
                        status: 200,
                        headers: { 'X-Goog-Upload-URL': 'https://upload.test/session/1' },
                    });
                }
                if (url.includes('upload.test/session/')) {
                    throw new TypeError('Error de red al subir archivo');
                }
                return new Response('{}', { status: 200 });
            });
            await expect(transcribir()).rejects.toThrow(/red al subir/i);
        });

        it('falla si la API no devuelve URL de subida', async () => {
            vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
            await expect(transcribir()).rejects.toThrow(/URL de upload/i);
        });

        it('propaga el error cuando el inicio de subida no es 200', async () => {
            vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));
            await expect(transcribir()).rejects.toThrow(/iniciar upload/i);
        });
    });

    /**
     * El estado del archivo subido se consultaba ignorando el código HTTP: un
     * 403 devolvía `{}` por el `.catch`, el `state` no era ni ACTIVE ni FAILED,
     * y el bucle gastaba sus 120 vueltas antes de culpar a un timeout que no
     * era. Lo que se comprueba aquí es que se rinde pronto y dice por qué.
     */
    describe('estado del archivo subido', () => {
        it('un 403 al consultar el estado falla en el acto, sin agotar el bucle', async () => {
            const ctx = installMocks(() => geminiStream(''));
            stubFileStatus(() => badKey());

            await expect(transcribir()).rejects.toThrow(/estado del audio subido/i);
            // Lo que importa: UNA consulta, no ciento veinte.
            expect(ctx.statusPolls).toBe(1);
        });

        it('un 500 se reintenta, pero no para siempre', async () => {
            const ctx = installMocks(() => geminiStream(''));
            stubFileStatus(() => new Response(JSON.stringify({ error: { message: 'backend error' } }), { status: 500 }));

            await expect(transcribir()).rejects.toThrow(/no informa del estado/i);
            // 3 consultas por subida, y la subida tiene un segundo intento:
            // un 5xx sostenido es pasajero por definición, así que volver a
            // subir el audio es una recuperación legítima. Seis, y se acabó.
            expect(ctx.statusPolls).toBe(6);
        });

        it('un 500 pasajero no tira la subida: a la tercera responde', async () => {
            const ctx = installMocks(() => geminiStream(fakeTranscript(0, 600)));
            stubFileStatus((poll) => poll < 3
                ? new Response('{}', { status: 503 })
                : new Response(JSON.stringify({ state: 'ACTIVE' }), { status: 200 }));

            await expect(transcribir()).resolves.toBeTruthy();
            expect(ctx.statusPolls).toBe(3);
        });

        it('FAILED se distingue de una consulta que falla', async () => {
            installMocks(() => geminiStream(''));
            stubFileStatus(() => new Response(
                JSON.stringify({ state: 'FAILED', error: { message: 'unsupported codec' } }),
                { status: 200 },
            ));

            await expect(transcribir()).rejects.toThrow(/unsupported codec/);
        });
    });

    describe('validación de key', () => {
        it('acepta una key buena', async () => {
            installMocks(() => geminiStream(''));
            await expect(validateGeminiKey('KEY')).resolves.toBe(true);
        });

        it('rechaza una key mala', async () => {
            vi.stubGlobal('fetch', async () => badKey());
            await expect(validateGeminiKey('MALA')).resolves.toBe(false);
        });

        it('no explota si no hay red', async () => {
            vi.stubGlobal('fetch', async () => { throw new TypeError('offline'); });
            await expect(validateGeminiKey('KEY')).resolves.toBe(false);
        });
    });
});

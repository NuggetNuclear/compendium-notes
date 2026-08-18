import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    transcribeWithGemini, transcribeWithGeminiChunked,
    CHUNK_SIZE_MINUTES, DURATION_THRESHOLD_CHUNKING, CHUNK_OVERLAP_SECONDS,
    MAX_RETRIES_PER_MODEL, modelCooldownMs, resetModelHealth,
} from '../../src/lib/gemini';
import { progress } from '../../src/lib/progress';
import { installMocks, fakeTranscript, audioFile, fourChunks, overloaded } from '../helpers/mock-gemini';

/** Respuesta SSE como la que devuelve `streamGenerateContent?alt=sse`. */
function sse(text: string, opts: { pieces?: number; finishReason?: string; tokens?: number } = {}): Response {
    const { pieces = 8, finishReason = 'STOP', tokens = 500 } = opts;
    const enc = new TextEncoder();
    const size = Math.ceil(text.length / pieces);

    return new Response(new ReadableStream({
        start(controller) {
            for (let i = 0; i < text.length; i += size) {
                const last = i + size >= text.length;
                const payload: any = {
                    candidates: [{ content: { parts: [{ text: text.slice(i, i + size) }] } }],
                };
                if (last) {
                    payload.candidates[0].finishReason = finishReason;
                    payload.usageMetadata = { candidatesTokenCount: tokens };
                }
                controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
            controller.close();
        },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * El fallo que arregla esto: la barra de un fragmento iba de 0 a 100 sin nada
 * en medio. No era una barra, era un interruptor con dos posiciones y minuto y
 * medio de silencio entre ellas. El avance real existía —el modelo emite
 * `[MM:SS]` conforme transcribe—, sólo que se tiraba a la basura al pedir la
 * respuesta entera de una vez.
 */
describe('progreso en streaming', () => {
    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    it('reconstruye el texto de un stream troceado en muchos eventos', async () => {
        installMocks(() => sse(fakeTranscript(0, 600), { pieces: 20 }));
        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 600, 0, 'auto');

        expect(r.text).toContain('[00:00]');
        expect(r.text).toContain('[09:30]');
        expect(r.tokensUsed).toBe(500);
    });

    it('publica avances intermedios mientras llega el texto', async () => {
        installMocks(() => sse(fakeTranscript(0, 600), { pieces: 20 }));

        const avances: number[] = [];
        await transcribeWithGemini(audioFile(), 'KEY', (p) => avances.push(p), 600, 0, 'auto');

        const intermedios = avances.filter((p) => p > 0.5 && p < 0.95);
        expect(intermedios.length).toBeGreaterThan(2);
        // Y siempre hacia adelante.
        expect([...intermedios].sort((a, b) => a - b)).toEqual(intermedios);
    });

    it('cada fragmento se va llenando en vez de saltar de 0 a 100', async () => {
        const { files, metadata, duration } = fourChunks();
        installMocks(() => sse(fakeTranscript(0, 1200), { pieces: 20 }));

        // Se espía la señal, no la instantánea: el tracker agrupa los avisos
        // cada 120 ms y aquí el stream entero se consume en un suspiro, así
        // que mirar el snapshot sólo enseñaría el último valor.
        const avances: number[] = [];
        const real = progress.setChunk.bind(progress);
        const espia = vi.spyOn(progress, 'setChunk').mockImplementation((i, estado, p) => {
            if (i === 0 && estado === 'active' && typeof p === 'number') avances.push(p);
            return real(i, estado, p);
        });

        await transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata, undefined, 1);
        espia.mockRestore();

        const intermedios = avances.filter((p) => p > 0 && p < 1);
        expect(intermedios.length).toBeGreaterThan(2);
        expect([...intermedios].sort((a, b) => a - b)).toEqual(intermedios);
        expect(progress.getSnapshot().chunks.every(c => c.progress === 1)).toBe(true);
    });

    it('anota en cada fragmento el modelo y los tokens que costó', async () => {
        const { files, metadata, duration } = fourChunks();
        installMocks(() => sse(fakeTranscript(0, 1200)));

        await transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata, undefined, 2);

        const chunks = progress.getSnapshot().chunks;
        expect(chunks.every(c => c.model === 'gemini-3.5-flash-lite')).toBe(true);
        expect(chunks.every(c => c.tokens > 0)).toBe(true);
        expect(chunks.every(c => c.requests >= 1)).toBe(true);
    });
});

/**
 * El tamaño del fragmento.
 *
 * Bajó de 20 a 10 minutos: una tirada de 20 minutos se degrada por el final
 * (se salta trozos, se atasca repitiendo, se queda sin tokens) y un fallo se
 * lleva por delante veinte minutos de clase. Con 10, lo que se pierde es la
 * mitad y la barra tiene el doble de resolución.
 */
describe('tamaño de fragmento', () => {
    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    it('trocea en fragmentos de 10 minutos', () => {
        expect(CHUNK_SIZE_MINUTES).toBe(10);
        expect(DURATION_THRESHOLD_CHUNKING).toBe(CHUNK_SIZE_MINUTES);
        expect(CHUNK_OVERLAP_SECONDS).toBeGreaterThan(0);
        expect(CHUNK_OVERLAP_SECONDS).toBeLessThan(CHUNK_SIZE_MINUTES * 60 * 0.1);
    });

    /**
     * El troceado lo hace FFmpeg antes de llegar aquí, cortando por TIEMPO.
     * Esta capa ya no corta nada por su cuenta: un archivo que llega entero se
     * transcribe entero. Antes lo partía por bytes, y todos los trozos menos el
     * primero salían sin cabecera — es decir, no eran audio.
     */
    it('un audio que llega entero se transcribe entero, sin inventar cortes', async () => {
        const media = 30 * 60;
        const archivo = audioFile('clase.mp3', 30 * 1024 * 1024);
        const ctx = installMocks(() => sse(fakeTranscript(0, 600)));

        await transcribeWithGeminiChunked(archivo, 'KEY', undefined, media, undefined, undefined, 2);

        expect(ctx.calls).toHaveLength(1);
        const chunks = progress.getSnapshot().chunks;
        expect(chunks).toHaveLength(1);
        expect(chunks[0].endSec - chunks[0].startSec).toBe(media);
    });
});

/**
 * El bucle degenerado ("no, no, no…") era el fallo más caro que había: el
 * modelo se atascaba y seguía generando hasta agotar el presupuesto de tokens,
 * y sólo al final —minutos después— se limpiaba el destrozo. Con la respuesta
 * en streaming se puede cortar en cuanto aparece.
 */
describe('bucle de repetición en caliente', () => {
    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    it('corta el stream en cuanto el modelo se atasca y conserva lo bueno', async () => {
        const bueno = fakeTranscript(0, 300);
        const atasco = 'no, '.repeat(4000);
        let leidos = 0;

        installMocks(() => {
            const enc = new TextEncoder();
            const trozos = [bueno, ...Array.from({ length: 40 }, () => atasco.slice(0, 500))];
            return new Response(new ReadableStream({
                async pull(controller) {
                    if (leidos >= trozos.length) return controller.close();
                    const payload = {
                        candidates: [{ content: { parts: [{ text: trozos[leidos++] }] } }],
                        usageMetadata: { candidatesTokenCount: 100 * leidos },
                    };
                    controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
                },
            }), { status: 200 });
        });

        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 300, 0, 'auto');

        expect(r.text).toContain('[00:00]');
        expect(r.text).not.toMatch(/no, no, no, no, no, no/);
        // No se leyó la respuesta entera: ahí está el ahorro.
        expect(leidos).toBeLessThan(40);

        const avisos = progress.getSnapshot().events.map(e => e.text).join(' | ');
        expect(avisos).toMatch(/atascó repitiendo/i);
    });
});

/**
 * Caída de Google, medida sobre el caso real.
 *
 * Siete fragmentos de una clase de 69 min, seis a la vez, y
 * `gemini-3.5-flash-lite` devolviendo 503 a todo. Antes, cada fragmento
 * descubría la caída por su cuenta: tres intentos contra el modelo muerto,
 * cambio, tres más — decenas de peticiones contra un servicio caído, a las que
 * nosotros mismos añadíamos carga. La cuarentena compartida es lo que impide
 * que una caída suya se convierta en una tormenta nuestra.
 */
describe('cuarentena compartida durante una caída', () => {
    const siete = () => ({
        files: Array.from({ length: 7 }, (_, i) => audioFile(`clase_part${i}.m4a`)),
        metadata: Array.from({ length: 7 }, (_, i) => ({ startTime: i * 600, endTime: (i + 1) * 600, index: i })),
        duration: 4200,
    });

    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    it('el primer fragmento paga el descubrimiento; los demás no repiten', async () => {
        const { files, metadata, duration } = siete();
        const ctx = installMocks((c) =>
            c.model === 'gemini-3.5-flash-lite' ? overloaded() : sse(fakeTranscript(0, 600)));

        const r = await transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata, undefined, 6);

        // El audio sale entero por el modelo que sí responde.
        expect(r.text).toContain('[00:00]');
        const muertas = ctx.calls.filter(c => c.model === 'gemini-3.5-flash-lite').length;
        const buenas = ctx.calls.filter(c => c.model === 'gemini-3.1-flash-lite').length;

        expect(buenas).toBe(7);
        // Siete fragmentos × 3 intentos = 21 peticiones inútiles sin cuarentena.
        //
        // El suelo real son seis: los seis que arrancan a la vez descubren la
        // caída cada uno con su petición, porque salen antes de que ninguno
        // haya vuelto. El séptimo ya encuentra el modelo apartado y no gasta
        // nada. Encima va UNA sonda sin streaming, para saber si lo que está
        // caído es el modelo o sólo esa ruta: la paga el primero que aparta el
        // modelo, y sólo él.
        expect(muertas).toBeLessThanOrEqual(6 + 1);
    });

    it('con toda la cadena caída no se dispara el número de peticiones', async () => {
        const { files, metadata, duration } = siete();
        const ctx = installMocks(() => overloaded());

        await expect(transcribeWithGeminiChunked(files, 'KEY', undefined, duration, metadata, undefined, 6))
            .rejects.toThrow(/saturad/i);

        // Sin cuarentena eran 7 × 2 modelos × 3 intentos × 2 pasadas = 84.
        expect(ctx.calls.length).toBeLessThanOrEqual(24);
    });

    it('una respuesta buena levanta la cuarentena', async () => {
        let caido = true;
        installMocks((c) =>
            (caido && c.model === 'gemini-3.5-flash-lite') ? overloaded() : sse(fakeTranscript(0, 600)));

        expect(modelCooldownMs('gemini-3.5-flash-lite')).toBe(0);
        await transcribeWithGemini(audioFile(), 'KEY', undefined, 600, 0, 'auto');
        expect(modelCooldownMs('gemini-3.5-flash-lite')).toBeGreaterThan(0);

        caido = false;
        resetModelHealth();
        const r = await transcribeWithGemini(audioFile(), 'KEY', undefined, 600, 0, 'auto');
        expect(r.modelUsed).toBe('gemini-3.5-flash-lite');
        expect(modelCooldownMs('gemini-3.5-flash-lite')).toBe(0);
    });
});

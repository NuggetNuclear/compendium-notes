import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { transcribeAudio, organizeNotes, validateGroqKey, GROQ_MODEL_CHAIN, GROQ_WHISPER_MODEL } from '../../src/lib/groq';
import { progress } from '../../src/lib/progress';
import {
    installMocks, groqStream, apiError, audioFile, repetitionLoop,
    mockAudioSlicing, restoreAudioSlicing,
} from '../helpers/mock-gemini';

/** Respuesta de Whisper en el formato verbose_json que pide la app. */
const whisper = (segments: Array<[number, string]>) =>
    new Response(JSON.stringify({
        segments: segments.map(([start, text]) => ({ start, text })),
        text: segments.map(s => s[1]).join(' '),
    }), { status: 200 });

const NOTAS_GROQ = `## Título
Criptografía Clásica
## Summary
- Punto uno del resumen con la extensión suficiente.
## Key Concepts
**Escítala**: cifrado espartano.
## Content
### [00:00] Introducción
Contenido desarrollado de la sección.
`;

describe('Groq · transcripción con Whisper', () => {
    beforeEach(() => progress.resetIdle());
    afterEach(() => {
        vi.unstubAllGlobals();
        restoreAudioSlicing();
    });

    it('convierte los segmentos en texto con timestamps', async () => {
        installMocks(() => whisper([[0, 'Hola a todos'], [65, 'Segunda parte']]));
        const texto = await transcribeAudio([audioFile()], 'KEY');

        expect(texto).toContain('[00:00] Hola a todos');
        expect(texto).toContain('[01:05] Segunda parte');
    });

    it('procesa los fragmentos en orden y reporta progreso', async () => {
        installMocks(() => whisper([[0, 'texto del fragmento']]));
        const vistos: number[] = [];
        await transcribeAudio([audioFile(), audioFile(), audioFile()], 'KEY', p => vistos.push(p));

        expect(vistos[vistos.length - 1]).toBe(1);
        expect(vistos).toEqual([...vistos].sort((a, b) => a - b));
    });

    it('actualiza el tablero de fragmentos', async () => {
        installMocks(() => whisper([[0, 'a']]));
        progress.start({ provider: 'groq', fileName: 'a.mp3', fileSize: 10, stages: ['transcribe'], locale: 'es' });
        progress.initChunks([{ startSec: 0, endSec: 600 }, { startSec: 600, endSec: 1200 }]);
        await transcribeAudio([audioFile(), audioFile()], 'KEY', undefined, [600, 600]);

        expect(progress.getSnapshot().chunks.every(c => c.status === 'done')).toBe(true);
    });

    it('limpia las repeticiones que Whisper suelta en los silencios', async () => {
        installMocks(() => whisper([[0, 'Contenido normal'], [30, repetitionLoop(200)]]));
        const texto = await transcribeAudio([audioFile()], 'KEY');

        expect(texto).not.toMatch(/no, no, no, no, no, no/);
        expect(texto).toContain('Contenido normal');
    });

    it('reintenta sólo el tramo en que Whisper se queda pegado', async () => {
        // Whisper se atasca en el minuto 9:48 de un fragmento de 20 minutos:
        // los diez que quedaban detrás se recuperan con una segunda petición
        // sobre el recorte, no repitiendo el fragmento entero.
        const { slices } = mockAudioSlicing();
        let n = 0;
        installMocks(() => ++n === 1
            ? whisper([[0, 'Contenido normal'], [588, 'no, '.repeat(200)]])
            : whisper([[0, 'lo que venía después']]));

        const texto = await transcribeAudio([audioFile()], 'KEY', undefined, [1200]);

        expect(slices).toEqual([{ startSec: 588, endSec: 1200 }]);
        expect(texto).toContain('Contenido normal');
        expect(texto).toContain('[09:48] lo que venía después');
        expect(texto).not.toMatch(/no, no, no, no/);
    });

    it('señala el hueco si el tramo atascado no se puede recuperar', async () => {
        // Sin FFmpeg no hay recorte posible: el documento lo dice en lugar de
        // terminar antes de tiempo aparentando estar completo.
        installMocks(() => whisper([[0, 'Contenido normal'], [588, 'no, '.repeat(200)]]));

        const texto = await transcribeAudio([audioFile()], 'KEY', undefined, [1200]);

        expect(texto).toContain('Contenido normal');
        expect(texto).toContain('falta el audio de 09:48 a 20:00');
    });

    it('usa el campo text si no hay segmentos', async () => {
        installMocks(() => new Response(JSON.stringify({ text: 'transcripción plana' }), { status: 200 }));
        expect(await transcribeAudio([audioFile()], 'KEY')).toBe('transcripción plana');
    });

    describe('errores de la API', () => {
        it.each([
            [401, /API Key inválida/],
            [413, /demasiado grande/],
            [429, /Límite de Groq/],
        ])('%i da un mensaje entendible', async (status, patron) => {
            installMocks(() => apiError(status, { error: { message: 'x' } }));
            await expect(transcribeAudio([audioFile()], 'KEY')).rejects.toThrow(patron);
        });

        it('propaga el mensaje del servidor en otros errores', async () => {
            installMocks(() => apiError(500, { error: { message: 'Internal server error' } }));
            await expect(transcribeAudio([audioFile()], 'KEY')).rejects.toThrow(/Internal server error/);
        });

        it('explica el timeout en lugar de soltar AbortError', async () => {
            installMocks(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
            await expect(transcribeAudio([audioFile()], 'KEY')).rejects.toThrow(/tardó demasiado/);
        });

        it('exige key y fragmentos', async () => {
            installMocks(() => whisper([[0, 'a']]));
            await expect(transcribeAudio([audioFile()], '')).rejects.toThrow(/API Key/);
            await expect(transcribeAudio([], 'KEY')).rejects.toThrow(/archivos/);
        });
    });
});

describe('Groq · organización con Llama', () => {
    const transcripcion = Array.from({ length: 40 }, (_, i) => `[00:${String(i).padStart(2, '0')}] Frase de la clase.`).join('\n');

    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    it('devuelve las notas usando streaming', async () => {
        const ctx = installMocks(() => groqStream(NOTAS_GROQ));
        const notas = await organizeNotes(transcripcion, 'KEY', undefined, 'short', 'auto');

        expect(notas).toContain('## Título');
        expect(ctx.calls[0].body.stream).toBe(true);
    });

    it('publica el avance por secciones', async () => {
        installMocks(() => groqStream(NOTAS_GROQ));
        progress.start({ provider: 'groq', fileName: 'a.mp3', fileSize: 10, stages: ['organize'], locale: 'es' });
        progress.beginStage('organize');

        await organizeNotes(transcripcion, 'KEY', undefined, 'short', 'auto');
        expect(progress.getSnapshot().stages[0].progress).toBeGreaterThan(0);
    });

    it('espera lo que diga retry-after en un 429 y reintenta', async () => {
        let n = 0;
        const ctx = installMocks(() => {
            if (++n === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
            return groqStream(NOTAS_GROQ);
        });

        const notas = await organizeNotes(transcripcion, 'KEY', undefined, 'short', 'auto');
        expect(notas).toContain('## Título');
        expect(ctx.calls).toHaveLength(2);
        expect(progress.getSnapshot().events.some(e => e.kind === 'retry')).toBe(true);
    });

    it('corta el stream si el modelo entra en bucle', async () => {
        installMocks(() => groqStream(NOTAS_GROQ + repetitionLoop(1200)));
        const notas = await organizeNotes(transcripcion, 'KEY', undefined, 'short', 'auto');

        expect(notas).not.toMatch(/no, no, no, no, no, no/);
        expect(notas).toContain('## Título');
    });

    it('trocea las transcripciones largas y las une', async () => {
        const larga = 'línea de transcripción con contenido real. '.repeat(2000);
        const ctx = installMocks(() => groqStream(NOTAS_GROQ));
        const notas = await organizeNotes(larga, 'KEY', undefined, 'short', 'auto');

        expect(ctx.calls.length).toBeGreaterThan(1);
        expect(notas).toContain('---');
    });

    it('propaga el error del servidor', async () => {
        installMocks(() => apiError(500, { error: { message: 'Service unavailable' } }));
        await expect(organizeNotes(transcripcion, 'KEY', undefined, 'short', 'auto'))
            .rejects.toThrow(/Service unavailable/);
    });

    it('exige key y transcripción', async () => {
        installMocks(() => groqStream(NOTAS_GROQ));
        await expect(organizeNotes(transcripcion, '')).rejects.toThrow(/API Key/);
        await expect(organizeNotes('', 'KEY')).rejects.toThrow(/transcripción/);
    });
});

describe('Groq · validación de key', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('acepta la buena y rechaza la mala', async () => {
        vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
        await expect(validateGroqKey('KEY')).resolves.toBe(true);

        vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
        await expect(validateGroqKey('MALA')).resolves.toBe(false);
    });
});


describe('Groq · modelos vigentes', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('no usa ningún modelo Llama: todos están retirados o en retirada', () => {
        expect(GROQ_MODEL_CHAIN.some(m => /llama/i.test(m))).toBe(false);
    });

    it('el primario es el recomendado por Groq como sustituto', () => {
        expect(GROQ_MODEL_CHAIN[0]).toBe('openai/gpt-oss-120b');
    });

    it('Whisper sigue siendo el turbo, que continúa en producción', () => {
        expect(GROQ_WHISPER_MODEL).toBe('whisper-large-v3-turbo');
    });

    it('manda el modelo de la cadena en la petición', async () => {
        const ctx = installMocks(() => groqStream('## Título\nX'));
        await organizeNotes('transcripción de prueba', 'KEY', undefined, 'short', 'auto');
        expect(ctx.calls[0].body.model).toBe(GROQ_MODEL_CHAIN[0]);
    });

    it('cae al siguiente modelo si el primero fue retirado', async () => {
        const ctx = installMocks((c) =>
            c.body.model === GROQ_MODEL_CHAIN[0]
                ? apiError(400, { error: { message: 'The model `openai/gpt-oss-120b` has been decommissioned' } })
                : groqStream('## Título\nContenido de los apuntes'));

        const notas = await organizeNotes('transcripción de prueba', 'KEY', undefined, 'short', 'auto');

        expect(notas).toContain('## Título');
        expect(ctx.calls).toHaveLength(2);
        expect(ctx.calls[1].body.model).toBe(GROQ_MODEL_CHAIN[1]);
    });

    it('un 404 también dispara el cambio de modelo', async () => {
        const ctx = installMocks((c) =>
            c.body.model === GROQ_MODEL_CHAIN[0]
                ? apiError(404, { error: { message: 'model not found' } })
                : groqStream('## Título\nX'));
        await organizeNotes('transcripción de prueba', 'KEY', undefined, 'short', 'auto');
        expect(ctx.calls[1].body.model).toBe(GROQ_MODEL_CHAIN[1]);
    });

    it('si toda la cadena está retirada, lo dice claro', async () => {
        installMocks(() => apiError(404, { error: { message: 'decommissioned' } }));
        await expect(organizeNotes('transcripción', 'KEY', undefined, 'short', 'auto'))
            .rejects.toThrow(/ya no está disponible|no queda alternativa/i);
    });

    it('el 429 se reintenta un número acotado de veces, no infinito', async () => {
        const ctx = installMocks(() => new Response('{}', { status: 429, headers: { 'retry-after': '1' } }));
        await expect(organizeNotes('transcripción', 'KEY', undefined, 'short', 'auto')).rejects.toThrow();
        // Antes se llamaba a sí misma sin límite: esto no puede dispararse.
        expect(ctx.calls.length).toBeLessThanOrEqual(3 * GROQ_MODEL_CHAIN.length);
    });

    it('el tope de salida cabe en la ventana de 8K tokens por minuto', async () => {
        const ctx = installMocks(() => groqStream('## Título\nX'));
        await organizeNotes('transcripción de prueba', 'KEY', undefined, 'short', 'auto');
        const body = ctx.calls[0].body;
        // Sumando todos los mensajes: el prompt va entero en uno solo desde que
        // lo construye `notes-prompt`, pero lo que importa aquí es el total.
        const chars = body.messages.reduce((n: number, msg: any) => n + msg.content.length, 0);
        expect(chars / 4 + body.max_tokens).toBeLessThan(8000);
    });
});

describe('Groq · resiliencia por fragmento y por parte', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('marca el hueco con su rango y conserva el resto', async () => {
        let n = 0;
        installMocks(() => (++n === 2
            ? apiError(400, { error: { message: 'Audio corrupto' } })
            : whisper([[0, 'Contenido de la clase']])));

        const texto = await transcribeAudio([audioFile(), audioFile(), audioFile()], 'KEY', undefined, [600, 600, 600]);

        expect(texto).toContain('Contenido de la clase');
        expect(texto).toContain('Falta el audio de [10:00] a [20:00]');
        expect(texto).toContain('Audio corrupto');
    });

    it('reintenta el fragmento si el error tiene arreglo', async () => {
        let n = 0;
        const ctx = installMocks(() => (++n === 1
            ? apiError(503, { error: { message: 'service unavailable' } })
            : whisper([[0, 'Contenido recuperado']])));

        const texto = await transcribeAudio([audioFile()], 'KEY');

        expect(texto).toContain('Contenido recuperado');
        expect(ctx.calls).toHaveLength(2);
    });

    it('no reintenta lo que no tiene arreglo', async () => {
        const ctx = installMocks(() => apiError(401, { error: { message: 'invalid key' } }));
        await expect(transcribeAudio([audioFile()], 'KEY')).rejects.toThrow(/API Key inválida/);
        expect(ctx.calls).toHaveLength(1);
    });

    it('sólo falla si no se salvó ningún fragmento', async () => {
        installMocks(() => apiError(400, { error: { message: 'Audio corrupto' } }));
        await expect(transcribeAudio([audioFile(), audioFile()], 'KEY')).rejects.toThrow(/Audio corrupto/);
    });

    it('una parte de los apuntes que falla no tira las demás', async () => {
        const larga = Array.from({ length: 600 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}] Frase número ${i} de la clase con contenido.`).join('\n');
        let n = 0;
        installMocks(() => (++n === 1
            ? apiError(400, { error: { message: 'contenido rechazado' } })
            : groqStream('## Sección\nContenido bueno de la parte.')));

        const notas = await organizeNotes(larga, 'KEY', undefined, 'short', 'auto');

        expect(notas).toContain('Contenido bueno');
        expect(notas).toContain('Falta esta parte de los apuntes');
        expect(notas).toContain('contenido rechazado');
    });
});

/**
 * Whisper también tenía el fallo del modelo único.
 *
 * Mismo patrón que en Gemini: elegir un modelo no puede significar perder el
 * audio cuando ese modelo concreto está saturado.
 */
describe('Groq · el modelo elegido no es el único', () => {
    afterEach(() => vi.unstubAllGlobals());

    const audio = () => [new File([new Uint8Array(2048)], 'clase.mp3', { type: 'audio/mpeg' })];

    it('cae al otro Whisper cuando el elegido se satura', async () => {
        progress.resetIdle();
        const vistos: string[] = [];
        vi.stubGlobal('fetch', async (_url: any, init: any) => {
            const modelo = String((init?.body as FormData)?.get?.('model') ?? '');
            vistos.push(modelo);
            if (modelo === 'whisper-large-v3-turbo') {
                return new Response(JSON.stringify({ error: { message: 'Service unavailable' } }), { status: 503 });
            }
            return new Response(JSON.stringify({ segments: [{ start: 0, text: 'Hola clase.' }] }), { status: 200 });
        });

        const texto = await transcribeAudio(audio(), 'KEY', undefined, [60], 'whisper-large-v3-turbo');

        expect(texto).toContain('Hola clase.');
        expect(vistos[0]).toBe('whisper-large-v3-turbo');
        expect(vistos).toContain('whisper-large-v3');
    }, 30000);

    it('no cambia de modelo por una key inválida: cambiar no arreglaría nada', async () => {
        progress.resetIdle();
        const vistos: string[] = [];
        vi.stubGlobal('fetch', async (_url: any, init: any) => {
            vistos.push(String((init?.body as FormData)?.get?.('model') ?? ''));
            return new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 });
        });

        await expect(transcribeAudio(audio(), 'KEY', undefined, [60], 'whisper-large-v3-turbo'))
            .rejects.toThrow(/API Key/i);

        expect(new Set(vistos).size).toBe(1);
    }, 30000);
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { organizeNotesWithGemini, GEMINI_ASSEMBLY_CHAIN, GEMINI_NOTES_FALLBACK_CHAIN } from '../../src/lib/gemini';
import { progress } from '../../src/lib/progress';
import { installMocks, geminiStream, fakeTranscript, repetitionLoop, badKey, overloaded, rateLimit } from '../helpers/mock-gemini';

const NOTAS = `# Introducción a la Criptografía Clásica
## 1. Resumen
- La criptografía oculta el contenido; la esteganografía oculta el mensaje.
## 2. Conceptos Clave
- **Escítala**: cifrado por transposición espartano.
## 3. Contenido
### [00:00] Introducción
Texto desarrollado de la sección con suficiente extensión.
## 4. Definiciones
> **Rot**: desplazamiento de letras.
`;

describe('organización de apuntes con Gemini', () => {
    const transcripcion = fakeTranscript(0, 1800);
    beforeEach(() => {
        progress.resetIdle();
        progress.start({ provider: 'gemini', fileName: 'a.m4a', fileSize: 1000, stages: ['organize'], locale: 'es' });
        progress.beginStage('organize');
    });
    afterEach(() => vi.unstubAllGlobals());

    it('devuelve las notas y los tokens consumidos', async () => {
        installMocks(() => geminiStream(NOTAS, { tokens: 4321 }));
        const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

        expect(r.notes).toContain('# Introducción a la Criptografía');
        expect(r.tokensUsed).toBe(4321);
    });

    describe('apuntes que se cortan a la mitad', () => {
        /**
         * Lo observado: el PDF terminaba a media clase y nada lo decía. La
         * redacción es UNA petición, y si el modelo agota su presupuesto de
         * escritura el documento acaba donde acabe. `finishReason` traía el
         * aviso desde el principio; sólo se escribía en la consola.
         */
        it('avisa dentro del documento cuando el modelo agota su límite', async () => {
            installMocks(() => geminiStream(NOTAS, { finishReason: 'MAX_TOKENS' }));
            const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

            expect(r.notes).toContain('límite de escritura');
            // Y dice hasta qué minuto de la clase llegaron los apuntes.
            expect(r.notes).toContain('hasta 00:00');
            // Lo redactado sigue estando entero.
            expect(r.notes).toContain('# Introducción a la Criptografía');
        });

        it('lo cuenta también en el registro de la ejecución', async () => {
            installMocks(() => geminiStream(NOTAS, { finishReason: 'MAX_TOKENS' }));
            await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

            const eventos = progress.getSnapshot().events.map(e => e.text).join(' | ');
            expect(eventos).toMatch(/límite de escritura/);
        });

        it('señala cualquier otro final anómalo, no sólo el de tokens', async () => {
            installMocks(() => geminiStream(NOTAS, { finishReason: 'RECITATION' }));
            const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

            expect(r.notes).toContain('RECITATION');
        });

        it('no dice nada cuando los apuntes terminan bien', async () => {
            installMocks(() => geminiStream(NOTAS));
            const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

            expect(r.notes).not.toContain('⚠️');
        });
    });

    it('publica el avance por secciones', async () => {
        const ctx = installMocks(() => geminiStream(NOTAS));
        const detalles: string[] = [];
        const unsub = progress.subscribe(() => {
            const d = progress.getSnapshot().detail;
            if (d && detalles[detalles.length - 1] !== d) detalles.push(d);
        });

        await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');
        await new Promise(r => setTimeout(r, 200));
        unsub();

        // Se pide en streaming: es lo que permite mover la barra sección a
        // sección en vez de saltar de 0 a 100 al final.
        expect(ctx.calls[0].url).toContain(':streamGenerateContent');
        expect(ctx.calls[0].url).toContain('alt=sse');
        expect(detalles.some(d => /Redactando|Analizando/.test(d))).toBe(true);
    });

    it('avanza los pasos que consume la interfaz antigua', async () => {
        installMocks(() => geminiStream(NOTAS));
        const pasos: number[] = [];
        await organizeNotesWithGemini(transcripcion, 'KEY', (s) => pasos.push(s), 'short', 'auto');

        expect(pasos.length).toBeGreaterThan(2);
        expect(Math.max(...pasos)).toBe(5);
    });

    it('el techo de tokens es proporcional a la transcripción, no el máximo del modelo', async () => {
        const ctx = installMocks(() => geminiStream(NOTAS));
        await organizeNotesWithGemini('texto corto', 'KEY', undefined, 'short', 'auto');
        expect(ctx.calls[0].body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(65_536);
    });

    it('exige idioma de salida cuando se fija uno', async () => {
        const ctx = installMocks(() => geminiStream(NOTAS));
        await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'en');
        expect(ctx.calls[0].prompt).toContain('ENGLISH');
    });

    it('corta y reintenta si el modelo entra en bucle', async () => {
        let n = 0;
        const ctx = installMocks(() => (++n === 1 ? geminiStream(NOTAS + repetitionLoop(1200)) : geminiStream(NOTAS)));
        const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

        expect(ctx.calls.length).toBeGreaterThanOrEqual(1);
        expect(r.notes).not.toMatch(/no, no, no, no, no, no/);
    });

    it('limpia la repetición aunque el reintento también se atasque', async () => {
        installMocks(() => geminiStream(NOTAS + repetitionLoop(1200)));
        const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');
        expect(r.notes).toContain('repetición del modelo omitida');
        expect(r.notes).toContain('# Introducción');
    });

    it('propaga una key inválida sin reintentar', async () => {
        const ctx = installMocks(() => badKey());
        await expect(organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto'))
            .rejects.toThrow(/API key not valid/);
        expect(ctx.calls).toHaveLength(1);
    });

    it('sobrevive a la saturación cambiando de modelo', async () => {
        const ctx = installMocks((c) => (c.model.includes('lite') ? overloaded() : geminiStream(NOTAS)));
        const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');
        expect(r.notes).toContain('# Introducción');
        expect(ctx.calls[ctx.calls.length - 1].model).not.toContain('lite');
    });

    it('respeta el retryDelay en un 429', async () => {
        let n = 0;
        const ctx = installMocks(() => (++n === 1 ? rateLimit(2) : geminiStream(NOTAS)));
        await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');
        expect(ctx.calls).toHaveLength(2);
    });

    it('falla si no hay transcripción', async () => {
        installMocks(() => geminiStream(NOTAS));
        await expect(organizeNotesWithGemini('', 'KEY')).rejects.toThrow(/transcription/i);
    });

    it('falla si no hay key', async () => {
        installMocks(() => geminiStream(NOTAS));
        await expect(organizeNotesWithGemini(transcripcion, '')).rejects.toThrow(/API Key/i);
    });

    it('falla con motivo si el modelo no genera nada', async () => {
        installMocks(() => geminiStream('', { finishReason: 'RECITATION' }));
        await expect(organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto'))
            .rejects.toThrow(/RECITATION/);
    });
});

/**
 * Quién redacta.
 *
 * Transcribir son N peticiones y por eso lo hacen los Lite; redactar es UNA y
 * por eso entra un Flash. La parte delicada es el final de esa cadena: los
 * Flash tienen 20 peticiones al día cada uno y se agotan de verdad. No hay Pro
 * al que subir —en el free tier salen todos con cuota cero—, así que la
 * alternativa real es un Lite. Devolver un error ahí sería tirar una
 * transcripción entera ya pagada.
 */
describe('quién redacta los apuntes', () => {
    const transcripcion = fakeTranscript(0, 1800);

    beforeEach(() => progress.resetIdle());
    afterEach(() => vi.unstubAllGlobals());

    it('empieza por un Flash, no por un Flash Lite', async () => {
        const ctx = installMocks(() => geminiStream(NOTAS));
        await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

        expect(ctx.calls[0].model).toBe(GEMINI_ASSEMBLY_CHAIN[0]);
        expect(ctx.calls[0].model).not.toContain('lite');
    });

    it('sin Flash disponibles redacta con Flash Lite en vez de fallar', async () => {
        const ctx = installMocks((c) =>
            c.model.includes('lite') ? geminiStream(NOTAS) : overloaded());

        const r = await organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto');

        expect(r.notes).toContain('# Introducción a la Criptografía');
        expect(ctx.calls[ctx.calls.length - 1].model).toBe(GEMINI_NOTES_FALLBACK_CHAIN[0]);

        const avisos = progress.getSnapshot().events.map(e => e.text).join(' | ');
        expect(avisos).toMatch(/Flash Lite/);
    });

    /** Ningún Pro: en el free tier salen todos con cuota 0/0. */
    it('no intenta ningún modelo Pro en ninguna circunstancia', async () => {
        const ctx = installMocks(() => overloaded());
        await expect(organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto')).rejects.toThrow();

        expect(ctx.calls.every(c => !c.model.includes('pro'))).toBe(true);
    });

    it('una key inválida no arrastra a la cadena entera', async () => {
        const ctx = installMocks(() => badKey());
        await expect(organizeNotesWithGemini(transcripcion, 'KEY', undefined, 'short', 'auto'))
            .rejects.toThrow(/API key/i);

        expect(ctx.calls).toHaveLength(1);
    });
});

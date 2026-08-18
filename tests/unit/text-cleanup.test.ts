import { describe, it, expect } from 'vitest';
import {
    stripRepetitionRuns,
    tailRepetitionRun,
    repetitionResumePoint,
    shiftTimestamps,
    lastTimestampSeconds,
    lastTimestampLabel,
} from '../../src/lib/text-cleanup';
import { repetitionLoop, fakeTranscript } from '../helpers/mock-gemini';

describe('detección de bucles de repetición', () => {
    it('colapsa la racha observada en producción ("no, no, no…")', () => {
        const bueno = fakeTranscript(0, 600);
        const { text, removed } = stripRepetitionRuns(bueno + repetitionLoop(500));

        expect(removed).toBeGreaterThan(1500);
        expect(text).toContain('[…repetición del modelo omitida]');
        // Sólo una marca: la racha entera se colapsa de una vez.
        expect(text.match(/repetición del modelo omitida/g)).toHaveLength(1);
        // El contenido bueno anterior sigue intacto.
        expect(text).toContain('[00:00]');
        expect(text).toContain('[09:30]');
    });

    it('conserva dos repeticiones para no desfigurar la frase original', () => {
        const { text } = stripRepetitionRuns(`Dicen, están caminando, ${'no, '.repeat(60)}`);
        expect(text).toMatch(/caminando, no, no, \[…/);
    });

    it('atraviesa los saltos de línea de la respuesta del modelo', () => {
        // El modelo emite la racha en varias líneas; si el separador fuera
        // rígido, el bucle se partiría en trozos y la mitad pasaría al PDF.
        const conSaltos = 'texto previo ' + 'no,\nno, no,\nno, '.repeat(30);
        const { text, removed } = stripRepetitionRuns(conSaltos);
        expect(removed).toBeGreaterThan(200);
        expect((text.match(/no,/g) || []).length).toBeLessThan(6);
    });

    it('detecta frases cortas repetidas, no sólo palabras', () => {
        const { removed } = stripRepetitionRuns('bla ' + 'gracias por ver '.repeat(40));
        expect(removed).toBeGreaterThan(300);
    });

    describe('no toca el habla legítima', () => {
        const casos = [
            'Dijo sí, sí, sí, sí. Y siguió con la clase.',
            'no, no, no. Bueno, a ver.',
            'A, B, C, no, A, E, I, O, U.',
            'muy muy muy bueno',
            'Eso es, es, es lo que quería decir.',
        ];
        it.each(casos)('%s', (frase) => {
            expect(stripRepetitionRuns(frase).removed).toBe(0);
        });

        it('una transcripción normal completa', () => {
            expect(stripRepetitionRuns(fakeTranscript(0, 3600)).removed).toBe(0);
        });
    });

    describe('detección en caliente (para cortar el stream)', () => {
        it('salta pocos cientos de caracteres después de empezar el bucle', () => {
            const base = fakeTranscript(0, 600);
            let detectadoEn: number | null = null;
            for (let n = 20; n <= 2000; n += 20) {
                if (tailRepetitionRun(base + repetitionLoop(0) + 'no, '.repeat(n / 4))) {
                    detectadoEn = n;
                    break;
                }
            }
            expect(detectadoEn).not.toBeNull();
            expect(detectadoEn!).toBeLessThan(400);
        });

        it('no dispara con texto sano', () => {
            expect(tailRepetitionRun(fakeTranscript(0, 1200))).toBeNull();
        });

        it('sólo mira el final: un bucle ya limpiado no lo vuelve a disparar', () => {
            const limpio = stripRepetitionRuns(repetitionLoop(300)).text + fakeTranscript(600, 1200);
            expect(tailRepetitionRun(limpio)).toBeNull();
        });

        it('es barato sobre textos grandes', () => {
            const grande = fakeTranscript(0, 7200) + repetitionLoop(2000);
            const t0 = performance.now();
            stripRepetitionRuns(grande);
            tailRepetitionRun(grande);
            expect(performance.now() - t0).toBeLessThan(200);
        });
    });
});

describe('timestamps', () => {
    it('lee el último timestamp en segundos', () => {
        expect(lastTimestampSeconds('[00:30] hola [10:15] adiós')).toBe(615);
    });

    it('entiende el formato con horas', () => {
        expect(lastTimestampSeconds('[01:09:07] final')).toBe(4147);
    });

    it('devuelve null si no hay ninguno', () => {
        expect(lastTimestampSeconds('sin marcas de tiempo')).toBeNull();
    });

    it('ignora corchetes que no son timestamps', () => {
        expect(lastTimestampSeconds('[inaudible] [02:00] texto')).toBe(120);
    });

    it('devuelve la etiqueta tal cual para los avisos', () => {
        expect(lastTimestampLabel('[00:30] a [09:48] b')).toBe('[09:48]');
    });
});

describe('punto de reanudación tras un bucle', () => {
    it('corta por la marca que abre el segmento estropeado', () => {
        const texto = fakeTranscript(0, 300) + repetitionLoop(400);
        const punto = repetitionResumePoint(texto);

        // `repetitionLoop` arranca con [09:48]: ése es el segundo desde el que
        // hay que volver a pedir el audio.
        expect(punto).not.toBeNull();
        expect(punto!.resumeSec).toBe(588);
        // Lo conservado llega hasta ahí y no incluye ni una repetición.
        expect(punto!.kept).toContain('[04:30]');
        expect(punto!.kept).not.toContain('[09:48]');
        expect(punto!.kept).not.toMatch(/no, no/);
    });

    it('encuentra el bucle aunque el stream se cortara dentro de él', () => {
        // Cortado en seco: la racha se queda sin separador final, que es justo
        // lo que ocurre cuando la detección en caliente cierra el socket.
        const cortado = (fakeTranscript(0, 300) + repetitionLoop(400)).trimEnd();
        expect(repetitionResumePoint(cortado)?.resumeSec).toBe(588);
    });

    it('no ve nada donde no hay bucle', () => {
        expect(repetitionResumePoint(fakeTranscript(0, 3600))).toBeNull();
    });

    it('se rinde si el bucle no tiene ninguna marca delante', () => {
        // Sin marca no se sabe por qué segundo volver a empezar.
        expect(repetitionResumePoint('no, '.repeat(200))).toBeNull();
    });
});

describe('reubicar un trozo reintentado', () => {
    it('desplaza todas las marcas y pasa a horas cuando toca', () => {
        const movido = shiftTimestamps('[00:00] uno\n[10:00] dos', 3000);
        expect(movido).toContain('[50:00] uno');
        expect(movido).toContain('[01:00:00] dos');
    });

    it('sin desplazamiento no toca el texto', () => {
        const texto = '[00:30] tal cual';
        expect(shiftTimestamps(texto, 0)).toBe(texto);
    });
});

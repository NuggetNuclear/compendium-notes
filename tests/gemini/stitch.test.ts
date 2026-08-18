import { describe, it, expect } from 'vitest';
import { stitchChunks } from '../../src/lib/gemini';

/**
 * La costura entre fragmentos.
 *
 * Cada fragmento se transcribe con sus tiempos contados desde sí mismo, y los
 * fragmentos se solapan unos segundos para no partir una frase. Coser es sumar
 * el segundo de inicio a cada marca y tirar lo que el fragmento anterior ya
 * cubrió.
 *
 * Antes esto se decidía comparando el TEXTO del final de un fragmento con el
 * del principio del siguiente y dando por duplicado lo que pasara del 85% de
 * parecido. El solape lo transcribe el modelo dos veces, en dos peticiones
 * distintas, así que casi nunca sale con las mismas palabras.
 */
describe('coser fragmentos', () => {
    it('pasa los tiempos de cada fragmento a tiempo absoluto', () => {
        const texto = stitchChunks([
            { text: '[00:00] Empieza la clase.', startSec: 0, endSec: 600 },
            { text: '[00:30] Seguimos.', startSec: 3600, endSec: 4200 },
        ]);

        expect(texto).toContain('[00:00] Empieza la clase.');
        // 3600 + 30 = una hora y media hora... media hora no: 1 h 00 min 30 s.
        expect(texto).toContain('[01:00:30] Seguimos.');
    });

    it('quita el solape aunque el modelo lo transcriba con otras palabras', () => {
        // El caso exacto que el parecido del 85% no reconocía: la misma frase
        // transcrita dos veces, con un verbo distinto al final.
        const texto = stitchChunks([
            {
                text: '[00:00] Buenos días.\n[10:00] Y entonces el teorema dice esto.',
                startSec: 0,
                endSec: 615,
            },
            {
                text: '[00:00] y entonces el teorema afirma esto\n[00:30] Pasamos al ejemplo.',
                startSec: 600,
                endSec: 1215,
            },
        ]);

        expect(texto).toContain('Y entonces el teorema dice esto.');
        expect(texto).not.toContain('afirma');
        expect(texto).toContain('[10:30] Pasamos al ejemplo.');
    });

    it('deja el aviso de un fragmento perdido tal cual y no descuadra los siguientes', () => {
        const texto = stitchChunks([
            { text: '[00:00] Primera parte.', startSec: 0, endSec: 615 },
            { text: '[⚠️ Falta el audio de 10:00 a 20:15: Audio corrupto]', startSec: 600, endSec: 1215 },
            { text: '[00:00] Tercera parte.', startSec: 1200, endSec: 1815 },
        ]);

        expect(texto).toContain('[⚠️ Falta el audio de 10:00 a 20:15: Audio corrupto]');
        // El aviso no cubre audio, así que la tercera parte conserva su tiempo.
        expect(texto).toContain('[20:00] Tercera parte.');
    });

    it('no pierde nada cuando los fragmentos no se solapan', () => {
        const texto = stitchChunks([
            { text: '[00:00] Uno.', startSec: 0, endSec: 600 },
            { text: '[00:00] Dos.', startSec: 600, endSec: 1200 },
        ]);

        expect(texto).toContain('[00:00] Uno.');
        expect(texto).toContain('[10:00] Dos.');
    });

    it('un texto sin marcas de tiempo se conserva entero', () => {
        expect(stitchChunks([{ text: 'Sin marcas.', startSec: 0, endSec: 60 }])).toBe('Sin marcas.');
    });
});

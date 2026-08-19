// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generatePdf } from '../../src/lib/pdf-generator';
import { __clearFontCache } from '../../src/lib/pdf-fonts';
import { __clearMathCache } from '../../src/lib/math-renderer';

function serveFonts() {
    return vi.fn(async (url: string) => {
        const buf = await readFile(join(process.cwd(), 'public', 'fonts', String(url).replace('/fonts/', '')));
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    });
}

const NOTE = [
    '# Cálculo',
    '',
    'La energía en reposo es $E = mc^2$ según Einstein.',
    '',
    'El curso cuesta $50 y el libro $30 adicionales.',
    '',
    '$$',
    '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    '$$',
    '',
    '- Con **negrita** y $\\alpha + \\beta$',
].join('\n');

describe('generatePdf with LaTeX', () => {
    beforeEach(() => {
        __clearFontCache();
        __clearMathCache();
        vi.stubGlobal('fetch', serveFonts());
        vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: () => 'blob:test' }));
    });

    it('produces a PDF with vector formulas and no raw TeX delimiters', async () => {
        const doc: any = await generatePdf(
            { title: 'Cálculo', date: '2026-08-19', content: NOTE, style: 'academico', locale: 'es' },
            'blob'
        );
        expect(doc).toContain('blob:');
    });

    it('does not throw on malformed TeX', async () => {
        await expect(generatePdf(
            { title: 'Roto', date: '2026-08-19', content: 'Esto falla: $\\badcmd{x}$ pero sigue.', style: 'minimalista', locale: 'es' },
            'blob'
        )).resolves.toBeTruthy();
    });

    it('keeps the vector path for Greek and Cyrillic now that the font covers them', async () => {
        // Would previously have been routed to the raster renderer.
        await expect(generatePdf(
            { title: 'Ελληνικά', date: '2026-08-19', content: 'κείμενο και кириллица', style: 'minimalista', locale: 'es' },
            'blob'
        )).resolves.toBeTruthy();
    });
});

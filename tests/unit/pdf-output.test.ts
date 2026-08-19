// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generatePdf } from '../../src/lib/pdf-generator';
import { __clearFontCache } from '../../src/lib/pdf-fonts';
import { __clearMathCache } from '../../src/lib/math-renderer';

// jsPDF defines `text` as an own property on each instance, so the only way
// to observe every draw is to wrap the constructor.
const captured = vi.hoisted(() => ({ drawn: [] as string[] }));

vi.mock('jspdf', async () => {
    const actual: any = await vi.importActual('jspdf');
    const Real = actual.default ?? actual.jsPDF;

    class Wrapped extends Real {
        constructor(...args: any[]) {
            super(...args);
            const original = (this as any).text.bind(this);
            (this as any).text = (txt: any, ...rest: any[]) => {
                if (Array.isArray(txt)) captured.drawn.push(...txt.filter(v => typeof v === 'string'));
                else if (typeof txt === 'string') captured.drawn.push(txt);
                return original(txt, ...rest);
            };
        }
    }

    return { ...actual, default: Wrapped, jsPDF: Wrapped };
});

function serveFonts() {
    return vi.fn(async (url: string) => {
        const buf = await readFile(join(process.cwd(), 'public', 'fonts', String(url).replace('/fonts/', '')));
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    });
}

const NOTE = [
    '# Cálculo Integral',
    '',
    'Texto con **negrita**, *cursiva* y `código`.',
    '',
    'La energía es $E = mc^2$ y el curso cuesta $50.',
    '',
    '$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$',
    '',
    '## Tabla',
    '',
    '| Símbolo | Significado |',
    '|---------|-------------|',
    '| α | ángulo |',
    '',
    '1. primero',
    '2. segundo',
    '    - anidado',
    '',
    '> Una cita importante.',
    '',
    '```python',
    'def f(x):',
    '    return x ** 2',
    '```',
].join('\n');

describe('rendered PDF content', () => {
    const drawn = captured.drawn;

    beforeEach(async () => {
        drawn.length = 0;
        __clearFontCache();
        __clearMathCache();
        vi.stubGlobal('fetch', serveFonts());
        vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: () => 'blob:test' }));
        await generatePdf(
            { title: 'Cálculo', date: '2026-08-19', content: NOTE, style: 'minimalista', locale: 'es' },
            'blob'
        );
    });

    const all = () => drawn.join('\n');

    it('does not leak bold or italic markers into prose', () => {
        // The code block legitimately contains "x ** 2", so exclude it.
        const prose = drawn.filter(l => !l.includes('return x'));
        expect(prose.some(l => l.includes('**'))).toBe(false);
        expect(prose.some(l => l.includes('`'))).toBe(false);
        expect(all()).toContain('negrita');
        expect(all()).toContain('cursiva');
        expect(all()).toContain('código');
    });

    it('does not leak math delimiters, because formulas are drawn as vectors', () => {
        expect(all()).not.toContain('$$');
        expect(all()).not.toContain('E = mc^2');
        expect(all()).not.toContain('\\int');
    });

    it('keeps a price as literal text', () => {
        expect(all()).toContain('$50');
    });

    it('does not leak table pipes, and keeps the cell contents', () => {
        expect(drawn.some(l => l.includes('|'))).toBe(false);
        expect(all()).toContain('Símbolo');
        expect(all()).toContain('ángulo');
    });

    it('numbers an ordered list and bullets the nested one', () => {
        expect(drawn).toContain('1.');
        expect(drawn).toContain('2.');
        expect(drawn).toContain('•');
        expect(all()).toContain('anidado');
    });

    it('keeps code verbatim, including characters that look like markdown', () => {
        expect(all()).toContain('def f(x):');
        expect(all()).toContain('return x ** 2');
    });

    it('does not leak fence or heading markers', () => {
        expect(drawn.some(l => l.includes('```'))).toBe(false);
        expect(drawn.some(l => /^#+\s/.test(l))).toBe(false);
        expect(all()).toContain('Tabla');
    });

    it('renders the quote text', () => {
        expect(all()).toContain('cita');
    });
});

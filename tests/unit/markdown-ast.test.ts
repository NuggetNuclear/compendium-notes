import { describe, it, expect } from 'vitest';
import { parseMarkdown, collectMathFromBlocks, type Block } from '../../src/lib/markdown-ast';

const first = (src: string): Block => parseMarkdown(src)[0];

describe('parseMarkdown', () => {
    it('reads headings with their level', () => {
        expect(first('### Sub')).toMatchObject({ type: 'heading', level: 3 });
    });

    it('keeps emphasis as styling instead of leaking markers', () => {
        const b: any = first('texto **negrita** y *cursiva*');
        expect(b.inlines.map((n: any) => [n.value, n.style])).toEqual([
            ['texto ', {}],
            ['negrita', { bold: true }],
            [' y ', {}],
            ['cursiva', { italic: true }],
        ]);
    });

    it('parses fenced code with its language', () => {
        expect(first('```python\nx = 1\n```')).toEqual({ type: 'code', text: 'x = 1', lang: 'python' });
    });

    it('parses ordered lists and their start', () => {
        expect(first('3. uno\n4. dos')).toMatchObject({ type: 'list', ordered: true, start: 3 });
    });

    it('parses nested lists', () => {
        const b: any = first('- padre\n    - hijo');
        expect(b.items[0][1]).toMatchObject({ type: 'list', ordered: false });
    });

    it('parses tables', () => {
        const b: any = first('| a | b |\n|---|---|\n| 1 | 2 |');
        expect(b.type).toBe('table');
        expect(b.header.length).toBe(2);
        expect(b.rows[0].length).toBe(2);
    });

    it('parses blockquotes as nested blocks', () => {
        const b: any = first('> cita');
        expect(b.type).toBe('quote');
        expect(b.blocks[0].type).toBe('paragraph');
    });

    it('promotes a lone display formula to its own block', () => {
        expect(first('$$x = y$$')).toEqual({ type: 'mathBlock', tex: 'x = y' });
    });

    it('keeps inline math inside the paragraph', () => {
        const b: any = first('la fórmula $E=mc^2$ aquí');
        expect(b.inlines.some((n: any) => n.kind === 'math' && n.tex === 'E=mc^2')).toBe(true);
    });

    it('still refuses to treat prices as math', () => {
        const b: any = first('cuesta $50 y $30');
        expect(b.inlines.every((n: any) => n.kind === 'text')).toBe(true);
    });

    it('keeps link labels and drops the URL', () => {
        const b: any = first('ver [la guía](https://example.com) aquí');
        expect(b.inlines.map((n: any) => n.value).join('')).toBe('ver la guía aquí');
    });
});

describe('collectMathFromBlocks', () => {
    it('finds math nested in lists, quotes and tables', () => {
        const blocks = parseMarkdown('- $a$\n\n> $b$\n\n| $c$ |\n|---|\n| $d$ |\n\n$$e$$');
        expect(collectMathFromBlocks(blocks).map(m => m.tex).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
});

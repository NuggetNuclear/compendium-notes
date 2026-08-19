import { describe, it, expect } from 'vitest';
import { splitMath, collectMath, joinDisplayMathBlocks } from '../../src/lib/markdown-math';

const math = (line: string) => splitMath(line).filter(s => s.kind === 'math');
const text = (line: string) => splitMath(line).map(s => s.kind === 'text' ? s.value : `«${(s as any).tex}»`).join('');

describe('splitMath', () => {
    it('extracts inline math', () => {
        expect(math('la energía es $E = mc^2$ siempre')).toEqual([
            { kind: 'math', tex: 'E = mc^2', display: false },
        ]);
    });

    it('extracts display math', () => {
        expect(math('$$\\int_0^1 x\\,dx$$')).toEqual([
            { kind: 'math', tex: '\\int_0^1 x\\,dx', display: true },
        ]);
    });

    it('leaves prices alone — the regression that motivated a real parser', () => {
        expect(math('cuesta $5 and $10 dólares')).toEqual([]);
        expect(text('cuesta $5 and $10 dólares')).toBe('cuesta $5 and $10 dólares');
    });

    it('ignores an escaped delimiter', () => {
        expect(math('cuesta \\$5 por $x$')).toEqual([
            { kind: 'math', tex: 'x', display: false },
        ]);
    });

    it('does not open on whitespace', () => {
        expect(math('a $ no math $ b')).toEqual([]);
    });

    it('ignores an unclosed delimiter', () => {
        expect(math('solo un $ suelto')).toEqual([]);
    });

    it('keeps bold markers intact for the downstream renderer', () => {
        expect(text('**negrita** y $x^2$')).toBe('**negrita** y «x^2»');
    });

    it('handles several expressions on one line', () => {
        expect(math('$a$ y $b$').map(m => (m as any).tex)).toEqual(['a', 'b']);
    });
});

describe('collectMath', () => {
    it('deduplicates across lines', () => {
        expect(collectMath(['$x$ aquí', 'y $x$ allá', '$$y$$'])).toEqual([
            { tex: 'x', display: false },
            { tex: 'y', display: true },
        ]);
    });
});

describe('joinDisplayMathBlocks', () => {
    it('folds a fenced block onto one line', () => {
        expect(joinDisplayMathBlocks('antes\n$$\nx = y\n$$\ndespués'))
            .toBe('antes\n$$x = y$$\ndespués');
    });

    it('leaves an unterminated fence untouched', () => {
        expect(joinDisplayMathBlocks('antes\n$$\nx = y')).toBe('antes\n$$\nx = y');
    });

    it('is a no-op without fences', () => {
        expect(joinDisplayMathBlocks('solo texto\ny más')).toBe('solo texto\ny más');
    });
});

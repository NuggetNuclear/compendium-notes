// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jsPDF from 'jspdf';
import { renderMath, preRenderMath, getRenderedMath, __clearMathCache } from '../../src/lib/math-renderer';
import { mathBoxSize, drawMathQueue } from '../../src/lib/pdf-math-draw';

describe('renderMath', () => {
    beforeEach(() => __clearMathCache());

    it('emits path outlines, so no font is needed for formulas', async () => {
        const r = await renderMath('\\frac{a}{b}', false);
        expect(r).not.toBeNull();
        expect(r!.svg).toContain('<path');
        expect(r!.svg).not.toContain('<use');
        expect(r!.widthEx).toBeGreaterThan(0);
        expect(r!.heightEx).toBeGreaterThan(0);
    });

    it('renders malformed TeX instead of throwing, so the PDF survives', async () => {
        const r = await renderMath('\\badcommand{x}', false);
        expect(r).not.toBeNull();
        expect(r!.svg).toContain('<svg');
    });

    it('returns <svg> as the root, not MathJax\'s <mjx-container> wrapper', async () => {
        // Regression: the wrapper made svg2pdf draw nothing and made the
        // data: URI used by the raster path invalid.
        const r = await renderMath('x^2', false);
        expect(r!.svg.startsWith('<svg')).toBe(true);
        expect(r!.svg).not.toContain('mjx-container');
    });

    it('reports a baseline offset for inline math', async () => {
        const r = await renderMath('\\frac{\\sqrt{\\pi}}{2}', false);
        expect(r!.verticalAlignEx).toBeLessThan(0);
    });

    it('caches, so preRenderMath makes lookups synchronous', async () => {
        expect(getRenderedMath('x^2', false)).toBeNull();
        await preRenderMath([{ tex: 'x^2', display: false }]);
        expect(getRenderedMath('x^2', false)).not.toBeNull();
    });
});

describe('mathBoxSize', () => {
    it('reports descent as a positive distance below the baseline', () => {
        // Regression: the sign was flipped, floating every formula above
        // its line.
        const box = mathBoxSize({ svg: '', widthEx: 5, heightEx: 3, verticalAlignEx: -0.8, display: false }, 10);
        expect(box.descent).toBeGreaterThan(0);
    });

    it('scales with the body font size', () => {
        const r = { svg: '', widthEx: 10, heightEx: 4, verticalAlignEx: -1, display: false };
        const small = mathBoxSize(r, 10);
        const large = mathBoxSize(r, 20);
        expect(large.width).toBeCloseTo(small.width * 2, 5);
        expect(small.descent).toBeGreaterThan(0);
    });
});

describe('drawMathQueue', () => {
    beforeEach(() => __clearMathCache());

    it('draws formulas as vectors, not as an embedded bitmap', async () => {
        const rendered = await renderMath('E = mc^2', false);
        const doc = new jsPDF();
        const empty = Buffer.from(doc.output('arraybuffer')).length;

        await drawMathQueue(doc, [{
            page: 1, x: 20, y: 20, width: 30, height: 10, svg: rendered!.svg,
        }]);

        const raw = Buffer.from(doc.output('arraybuffer')).toString('latin1');
        expect(raw).not.toMatch(/\/Subtype\s*\/Image/);
        // An empty document is ~3KB; real path data adds several KB. A tiny
        // delta means svg2pdf silently drew nothing, which is how the
        // mjx-container bug hid.
        expect(raw.length - empty).toBeGreaterThan(5000);
    });

    it('is a no-op on an empty queue', async () => {
        const doc = new jsPDF();
        await expect(drawMathQueue(doc, [])).resolves.toBeUndefined();
    });

    it('skips a broken formula rather than failing the document', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const doc = new jsPDF();

        await drawMathQueue(doc, [{
            page: 1, x: 0, y: 0, width: 10, height: 10, svg: '<not valid svg',
        }]);

        expect(doc.getNumberOfPages()).toBe(1);
        warn.mockRestore();
    });
});

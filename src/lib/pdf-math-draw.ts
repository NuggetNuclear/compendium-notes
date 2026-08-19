import type jsPDF from 'jspdf';
import type { RenderedMath } from './math-renderer';

// ---------------------------------------------------------------------------
// Placing MathJax SVG into a jsPDF document.
//
// Layout runs synchronously and records boxes here; svg2pdf is async, so the
// actual drawing happens in one pass afterwards. Each entry remembers its page
// because a formula may land after a page break.
// ---------------------------------------------------------------------------

export interface QueuedMath {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    svg: string;
}

const PT_TO_MM = 25.4 / 72;

// MathJax sizes its output in ex units of the surrounding text. Liberation's
// x-height is 1082/2048 em; close enough for both families that math sits at
// the right optical size next to the body copy.
const X_HEIGHT_RATIO = 0.528;

export interface MathBox {
    width: number;
    height: number;
    /** How far the box hangs below the baseline, in mm. */
    descent: number;
}

export function mathBoxSize(rendered: RenderedMath, fontSizePt: number): MathBox {
    const exMm = fontSizePt * X_HEIGHT_RATIO * PT_TO_MM;
    return {
        width: rendered.widthEx * exMm,
        height: rendered.heightEx * exMm,
        // vertical-align is negative when the box drops below the baseline.
        descent: -rendered.verticalAlignEx * exMm,
    };
}

/**
 * Draws every queued formula as vector paths. Failures are per-formula: one
 * unrenderable expression must not cost the whole document.
 */
export async function drawMathQueue(doc: jsPDF, queue: QueuedMath[]): Promise<void> {
    if (queue.length === 0) return;

    let svg2pdf: any;
    try {
        const mod: any = await import('svg2pdf.js');
        svg2pdf = mod.svg2pdf ?? mod.default?.svg2pdf ?? mod.default;
        if (typeof svg2pdf !== 'function') throw new Error('svg2pdf export not callable');
    } catch (err) {
        console.warn('[pdf] svg2pdf unavailable; formulas will be omitted.', err);
        return;
    }

    // svg2pdf reads geometry off a live element, so the nodes need to be in a
    // document — parked offscreen rather than shown.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;';
    document.body.appendChild(host);

    const originalPage = doc.getCurrentPageInfo().pageNumber;

    try {
        for (const item of queue) {
            host.innerHTML = item.svg;
            const element = host.firstElementChild as SVGElement | null;
            if (!element) continue;

            try {
                doc.setPage(item.page);
                await svg2pdf(element, doc, {
                    x: item.x,
                    y: item.y,
                    width: item.width,
                    height: item.height,
                });
            } catch (err) {
                console.warn('[pdf] Could not draw a formula; skipping it.', err);
            } finally {
                host.innerHTML = '';
            }
        }
    } finally {
        document.body.removeChild(host);
        doc.setPage(originalPage);
    }
}

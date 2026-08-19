import type { Block, Inline, InlineStyle } from './markdown-ast';
import { getRenderedMath } from './math-renderer';
import { mathBoxSize, type QueuedMath } from './pdf-math-draw';

// ---------------------------------------------------------------------------
// Vector renderer: markdown AST -> jsPDF drawing operations.
//
// Text and formulas are laid out in one synchronous pass. Math is measured and
// queued here rather than drawn, because svg2pdf is async; the queue is
// flushed once the whole document has been positioned.
// ---------------------------------------------------------------------------

export interface RenderContext {
    doc: any;
    fontBody: string;
    fontTitle: string;
    fontMono: string;
    mathQueue: QueuedMath[];
    pageHeight: number;
    margin: number;
    state: { y: number };
    /** Runs on page break, so a style can redraw its furniture. */
    onNewPage?: () => void;
    baseSize: number;
    lineHeight: number;
    primaryColor: [number, number, number];
    accentColor: [number, number, number];
}

export function checkBreak(ctx: RenderContext, needed: number): void {
    if (ctx.state.y + needed <= ctx.pageHeight - 20) return;
    ctx.doc.addPage();
    ctx.state.y = ctx.margin;
    ctx.onNewPage?.();
}

function fontFor(ctx: RenderContext, style: InlineStyle): [string, string] {
    const family = style.code ? ctx.fontMono : ctx.fontBody;
    // Only three faces are embedded per family, so bold wins over italic.
    const weight = style.bold ? 'bold' : style.italic ? 'italic' : 'normal';
    return [family, weight];
}

/**
 * Lays out a run of inline nodes inside [x, x+width], wrapping on word
 * boundaries and treating each formula as a single unbreakable atom.
 */
export function layoutInlines(
    ctx: RenderContext,
    inlines: Inline[],
    x: number,
    width: number,
    fontSize: number,
    color: [number, number, number]
): void {
    const { doc } = ctx;
    const lineHeight = fontSize * 0.5;
    let cursorX = x;
    // Inline math can be taller than the text line (fractions, sums with
    // limits); remember the excess and pay it back as trailing space.
    let overflow = 0;

    doc.setFontSize(fontSize);
    doc.setTextColor(...color);

    const newline = () => {
        ctx.state.y += lineHeight;
        cursorX = x;
        checkBreak(ctx, lineHeight);
    };

    for (const node of inlines) {
        if (node.kind === 'math') {
            const rendered = getRenderedMath(node.tex, node.display);
            if (!rendered) {
                // Nothing to draw: show the source rather than a gap.
                drawWords(ctx, node.tex, ctx.fontBody, 'normal', x, width, lineHeight, () => cursorX, v => { cursorX = v; }, newline);
                continue;
            }

            const box = mathBoxSize(rendered, fontSize);
            if (cursorX + box.width > x + width && cursorX > x) newline();

            ctx.mathQueue.push({
                page: doc.getCurrentPageInfo().pageNumber,
                x: cursorX,
                y: ctx.state.y + box.descent - box.height,
                width: box.width,
                height: box.height,
                svg: rendered.svg,
            });
            overflow = Math.max(overflow, box.height - lineHeight);
            cursorX += box.width + doc.getTextWidth(' ');
            continue;
        }

        const [family, weight] = fontFor(ctx, node.style);
        doc.setFont(family, weight);
        drawWords(ctx, node.value, family, weight, x, width, lineHeight,
            () => cursorX, v => { cursorX = v; }, newline, node.style.strike);
    }

    ctx.state.y += overflow;
}

function drawWords(
    ctx: RenderContext,
    text: string,
    family: string,
    weight: string,
    x: number,
    width: number,
    lineHeight: number,
    getX: () => number,
    setX: (v: number) => void,
    newline: () => void,
    strike?: boolean
): void {
    const { doc } = ctx;
    doc.setFont(family, weight);

    // Preserve a single separating space between runs, drop the rest.
    const words = text.split(/(\s+)/).filter(w => w !== '');

    for (const word of words) {
        if (/^\s+$/.test(word)) {
            const spaceWidth = doc.getTextWidth(' ');
            if (getX() > x) setX(getX() + spaceWidth);
            continue;
        }

        const wordWidth = doc.getTextWidth(word);
        if (getX() + wordWidth > x + width && getX() > x) newline();

        doc.text(word, getX(), ctx.state.y);
        if (strike) {
            doc.setLineWidth(0.2);
            doc.line(getX(), ctx.state.y - 1, getX() + wordWidth, ctx.state.y - 1);
        }
        setX(getX() + wordWidth);
    }
}

// --- blocks ----------------------------------------------------------------

export function renderBlocks(ctx: RenderContext, blocks: Block[], x: number, width: number): void {
    for (const block of blocks) renderBlock(ctx, block, x, width);
}

function renderBlock(ctx: RenderContext, block: Block, x: number, width: number): void {
    const { doc, state } = ctx;

    switch (block.type) {
        case 'heading': {
            const sizes = [ctx.baseSize + 8, ctx.baseSize + 4, ctx.baseSize + 1.5, ctx.baseSize];
            const size = sizes[Math.min(block.level, 4) - 1];
            checkBreak(ctx, size);
            state.y += block.level === 1 ? 4 : 3;
            doc.setFont(ctx.fontTitle, 'bold');
            layoutInlines(ctx, block.inlines, x, width, size,
                block.level >= 3 ? ctx.accentColor : ctx.primaryColor);
            state.y += size * 0.5 + 2;
            break;
        }

        case 'paragraph':
            checkBreak(ctx, ctx.baseSize);
            layoutInlines(ctx, block.inlines, x, width, ctx.baseSize, [50, 50, 50]);
            state.y += ctx.lineHeight + 3;
            break;

        case 'mathBlock': {
            const rendered = getRenderedMath(block.tex, true);
            if (!rendered) {
                layoutInlines(ctx, [{ kind: 'text', value: block.tex, style: { code: true } }], x, width, ctx.baseSize, [50, 50, 50]);
                state.y += ctx.lineHeight + 3;
                break;
            }
            const box = mathBoxSize(rendered, ctx.baseSize + 1);
            const scale = box.width > width ? width / box.width : 1;
            const w = box.width * scale;
            const h = box.height * scale;

            checkBreak(ctx, h + 6);
            state.y += 3;
            ctx.mathQueue.push({
                page: doc.getCurrentPageInfo().pageNumber,
                x: x + (width - w) / 2,
                y: state.y,
                width: w,
                height: h,
                svg: rendered.svg,
            });
            state.y += h + 6;
            break;
        }

        case 'code': {
            const size = ctx.baseSize - 1.5;
            doc.setFont(ctx.fontMono, 'normal');
            doc.setFontSize(size);

            const lines: string[] = [];
            for (const raw of block.text.split('\n')) {
                lines.push(...(doc.splitTextToSize(raw || ' ', width - 6) as string[]));
            }
            const lineH = size * 0.48;

            checkBreak(ctx, Math.min(lines.length * lineH + 6, 40));
            const boxTop = state.y - 3;
            const boxHeight = lines.length * lineH + 5;

            doc.setFillColor(246, 246, 248);
            doc.rect(x, boxTop, width, boxHeight, 'F');
            doc.setDrawColor(225, 225, 232);
            doc.setLineWidth(0.2);
            doc.rect(x, boxTop, width, boxHeight, 'S');

            doc.setTextColor(30, 30, 40);
            for (const line of lines) {
                checkBreak(ctx, lineH);
                doc.text(line, x + 3, state.y + 1);
                state.y += lineH;
            }
            state.y += 6;
            break;
        }

        case 'quote': {
            const inset = 6;
            const top = state.y - 3;
            const startPage = doc.getCurrentPageInfo().pageNumber;

            doc.setFillColor(248, 248, 248);
            renderBlocks(ctx, block.blocks, x + inset, width - inset);

            // Only rule the bar when the quote stayed on one page; drawing it
            // across a break would need a second layout pass.
            if (doc.getCurrentPageInfo().pageNumber === startPage) {
                doc.setDrawColor(...ctx.primaryColor);
                doc.setLineWidth(1.2);
                doc.line(x, top, x, state.y - 2);
            }
            state.y += 2;
            break;
        }

        case 'list': {
            const indent = 6;
            let index = block.start;

            for (const item of block.items) {
                checkBreak(ctx, ctx.baseSize);
                const marker = block.ordered ? `${index}.` : '•';
                doc.setFont(ctx.fontBody, 'normal');
                doc.setFontSize(ctx.baseSize);
                doc.setTextColor(60, 60, 60);
                doc.text(marker, x, state.y);

                renderBlocks(ctx, item, x + indent, width - indent);
                index++;
            }
            state.y += 2;
            break;
        }

        case 'table': {
            const columns = Math.max(block.header.length, ...block.rows.map(r => r.length), 1);
            const colWidth = width / columns;
            const size = ctx.baseSize - 1;

            const drawRow = (cells: Inline[][], bold: boolean) => {
                checkBreak(ctx, size + 4);
                const rowTop = state.y;
                let maxY = state.y;

                cells.forEach((cell, i) => {
                    state.y = rowTop;
                    const styled = bold
                        ? cell.map(n => n.kind === 'text' ? { ...n, style: { ...n.style, bold: true } } : n)
                        : cell;
                    layoutInlines(ctx, styled, x + i * colWidth + 2, colWidth - 4, size, [40, 40, 40]);
                    maxY = Math.max(maxY, state.y);
                });

                state.y = maxY + 3;
                doc.setDrawColor(215, 215, 220);
                doc.setLineWidth(0.2);
                doc.line(x, state.y - 1.5, x + width, state.y - 1.5);
            };

            state.y += 2;
            if (block.header.length) drawRow(block.header, true);
            for (const row of block.rows) drawRow(row, false);
            state.y += 4;
            break;
        }

        case 'rule':
            checkBreak(ctx, 6);
            state.y += 2;
            doc.setDrawColor(210, 210, 210);
            doc.setLineWidth(0.3);
            doc.line(x, state.y, x + width, state.y);
            state.y += 5;
            break;
    }
}

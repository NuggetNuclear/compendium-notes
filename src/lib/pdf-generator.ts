import jsPDF from 'jspdf';
import type { PdfStyle } from './store';
import { registerFontFamily, type PdfFontFamily } from './pdf-fonts';
import { joinDisplayMathBlocks } from './markdown-math';
import { parseMarkdown, plainTextBlocks, collectMathFromBlocks, type Block, type Inline } from './markdown-ast';
import { getRenderedMath, preRenderMath } from './math-renderer';
import { drawMathQueue, type QueuedMath } from './pdf-math-draw';
import { renderBlocks, checkBreak, type RenderContext } from './pdf-render-latin';
import { t, type Locale } from './i18n';

interface PdfOptions {
    title: string;
    date: string;
    duration?: string;
    content: string;
    style: PdfStyle;
    locale: Locale;
    isPlainText?: boolean;
}

interface StyleConfig {
    /** Embedded family used when the TTFs load. */
    embedFamily: PdfFontFamily;
    /** Built-in standard-14 face used only if embedding fails. */
    fallbackFont: string;
    primaryColor: [number, number, number];
    accentColor: [number, number, number];
    metaColor: [number, number, number];
    headerBg: boolean;
    headerColor?: [number, number, number];
    lineSeparator?: boolean;
    leftColumn?: boolean;
}

const STYLES: Record<PdfStyle, StyleConfig> = {
    minimalista: {
        embedFamily: 'LiberationSans',
        fallbackFont: 'helvetica',
        primaryColor: [0, 0, 0],
        accentColor: [100, 100, 100],
        metaColor: [140, 140, 140],
        headerBg: false,
    },
    academico: {
        embedFamily: 'LiberationSerif',
        fallbackFont: 'times',
        primaryColor: [0, 51, 102],
        accentColor: [100, 100, 100],
        metaColor: [130, 130, 130],
        headerBg: false,
        lineSeparator: true,
    },
    cornell: {
        embedFamily: 'LiberationSans',
        fallbackFont: 'helvetica',
        primaryColor: [17, 24, 39],
        accentColor: [55, 65, 81],
        metaColor: [107, 114, 128],
        leftColumn: true,
        headerBg: true,
        headerColor: [249, 250, 251],
    }
};

// ---------------------------------------------------------------------------
// Script detection
//
// Two separate questions, deliberately not one:
//
//  1. Does the text need a bigger font? Latin-Ext, Greek and Cyrillic are all
//     covered by the embedded Liberation faces, so they stay on the vector
//     path. Nothing to detect - embedding handles them.
//
//  2. Does the text need a real layout engine? jsPDF places glyphs one after
//     another: no bidi reordering, no OpenType shaping (GSUB/GPOS), no
//     dictionary line-breaking. Hebrew and Arabic would come out in visual
//     disorder, Indic scripts unreordered, Arabic unjoined, Thai unbroken.
//     No font fixes any of that, so these fall back to the raster path.
// ---------------------------------------------------------------------------
function requiresLayoutEngine(text: string): boolean {
    return /[\u0590-\u05FF\u0600-\u06FF\u0700-\u08FF\u0900-\u09FF\u0A00-\u0DFF\u0E00-\u0FFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text);
}

// ---------------------------------------------------------------------------
// RASTER FALLBACK: html2canvas -> jsPDF image.
// Only for scripts jsPDF cannot lay out at all (see above). Everything else
// takes the vector path, which is searchable, selectable and far smaller.
// ---------------------------------------------------------------------------
const escapeHtml = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inlinesToHtml(inlines: Inline[]): string {
    return inlines.map(node => {
        if (node.kind === 'math') {
            const rendered = getRenderedMath(node.tex, node.display);
            if (!rendered) return escapeHtml(node.tex);
            // html2canvas cannot lay out inline <svg>, but handles <img> fine.
            const uri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(rendered.svg)))}`;
            const style = node.display
                ? 'display:block;margin:12px auto;max-width:100%;'
                : `vertical-align:${rendered.verticalAlignEx}ex;height:${rendered.heightEx}ex;`;
            return `<img src="${uri}" style="${style}" alt="" />`;
        }

        let html = escapeHtml(node.value);
        if (node.style.code) html = `<code style="font-family:monospace;background:#f2f2f5;padding:1px 3px;border-radius:3px;">${html}</code>`;
        if (node.style.bold) html = `<strong style="font-weight:700;">${html}</strong>`;
        if (node.style.italic) html = `<em>${html}</em>`;
        if (node.style.strike) html = `<s>${html}</s>`;
        return html;
    }).join('');
}

function blocksToHtml(blocks: Block[], primary: string, bodyTxt: string, h2Border: string): string {
    const ww = 'word-wrap:break-word;overflow-wrap:break-word;word-break:break-word;';

    return blocks.map(block => {
        switch (block.type) {
            case 'heading': {
                const sizes = ['18px', '14px', '11.5px', '10.5px'];
                const size = sizes[Math.min(block.level, 4) - 1];
                const border = block.level === 2 ? h2Border : '';
                return `<div style="font-size:${size};font-weight:700;color:${primary};margin:18px 0 8px;${border}${ww}">${inlinesToHtml(block.inlines)}</div>`;
            }
            case 'paragraph':
                return `<div style="font-size:10.5px;color:${bodyTxt};margin:0 0 10px;line-height:1.7;${ww}">${inlinesToHtml(block.inlines)}</div>`;
            case 'mathBlock': {
                const rendered = getRenderedMath(block.tex, true);
                if (!rendered) return `<div style="font-family:monospace;font-size:10px;text-align:center;margin:12px 0;">${escapeHtml(block.tex)}</div>`;
                const uri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(rendered.svg)))}`;
                return `<img src="${uri}" style="display:block;margin:14px auto;max-width:100%;" alt="" />`;
            }
            case 'code':
                return `<pre style="background:#f6f6f8;border:1px solid #e1e1e8;border-radius:4px;padding:8px 10px;` +
                    `font-family:monospace;font-size:9.5px;line-height:1.5;color:#1e1e28;overflow-x:auto;margin:0 0 10px;white-space:pre-wrap;">${escapeHtml(block.text)}</pre>`;
            case 'quote':
                return `<div style="border-left:3px solid ${primary};background:#f8f8f8;padding:8px 12px;margin:0 0 10px;font-style:italic;color:#555;">` +
                    `${blocksToHtml(block.blocks, primary, bodyTxt, h2Border)}</div>`;
            case 'list': {
                const tag = block.ordered ? 'ol' : 'ul';
                const start = block.ordered ? ` start="${block.start}"` : '';
                const items = block.items.map(item =>
                    `<li style="font-size:10.5px;color:${bodyTxt};line-height:1.7;margin:3px 0;${ww}">${blocksToHtml(item, primary, bodyTxt, h2Border)}</li>`
                ).join('');
                return `<${tag}${start} style="margin:0 0 10px;padding-left:18px;">${items}</${tag}>`;
            }
            case 'table': {
                const cell = 'border:1px solid #dcdce4;padding:4px 6px;font-size:9.5px;';
                const head = block.header.length
                    ? `<tr>${block.header.map(c => `<th style="${cell}background:#f4f4f7;text-align:left;">${inlinesToHtml(c)}</th>`).join('')}</tr>`
                    : '';
                const body = block.rows.map(r =>
                    `<tr>${r.map(c => `<td style="${cell}">${inlinesToHtml(c)}</td>`).join('')}</tr>`).join('');
                return `<table style="border-collapse:collapse;width:100%;margin:0 0 12px;">${head}${body}</table>`;
            }
            case 'rule':
                return `<div style="border-top:1px solid #ddd;margin:14px 0;"></div>`;
        }
    }).join('');
}

function buildHtmlForCanvas(options: PdfOptions, blocks: Block[]): string {
    const { title, date, style } = options;
    const config = STYLES[style] || STYLES.minimalista;
    const primary = `rgb(${config.primaryColor.join(',')})`;
    const meta = `rgb(${config.metaColor.join(',')})`;
    const bodyTxt = '#2d2d2d';
    const ww = 'word-wrap:break-word;overflow-wrap:break-word;word-break:break-word;';

    // System stack: the browser picks a face per script and shapes it properly,
    // which is the entire reason this path exists.
    const fontStack = style === 'academico'
        ? '"Georgia","Times New Roman",serif'
        : '"Noto Sans","Segoe UI","PingFang SC","Hiragino Sans","Malgun Gothic","Arial Unicode MS",system-ui,sans-serif';

    const h2Border = style === 'academico'
        ? `border-bottom:1px solid ${primary};padding-bottom:4px;` : '';

    const hrHtml = style !== 'cornell'
        ? `<div style="border-top:${style === 'academico' ? `1px solid ${primary}` : '0.5px solid #ccc'};margin:0 0 20px;"></div>`
        : '';

    const headerWrap = style === 'cornell'
        ? `background:rgb(${(config.headerColor || [249, 250, 251]).join(',')});padding:28px 40px 20px;margin:-40px -40px 28px;`
        : '';

    const titleFontSize = style === 'academico' ? '22px' : style === 'cornell' ? '26px' : '24px';

    const headerHtml =
        `<div style="${headerWrap}">` +
        `<div style="font-size:${titleFontSize};font-weight:700;color:${primary};line-height:1.25;margin-bottom:8px;${ww}">${escapeHtml(title)}</div>` +
        `<div style="font-size:8.5px;color:${meta};margin-bottom:4px;">${date} \u2022 Compendium Notes</div>` +
        `</div>`;

    return `<div style="font-family:${fontStack};font-size:11px;color:${bodyTxt};background:#ffffff;` +
        `width:794px;max-width:794px;padding:40px;box-sizing:border-box;line-height:1.7;">` +
        `${headerHtml}${hrHtml}${blocksToHtml(blocks, primary, bodyTxt, h2Border)}</div>`;
}

async function generatePdfViaCanvas(options: PdfOptions, blocks: Block[], action: 'save' | 'blob'): Promise<string | void> {
    const html2canvas = (await import('html2canvas')).default;

    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:0;width:794px;';
    container.innerHTML = buildHtmlForCanvas(options, blocks);
    document.body.appendChild(container);

    const target = container.firstElementChild as HTMLElement;

    try {
        const canvas = await html2canvas(target, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            width: 794,
            windowWidth: 794,
            scrollX: 0,
            scrollY: 0,
        } as any);

        document.body.removeChild(container);

        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();

        const scale = 2;
        const pxPerMm = (794 * scale) / pageW;
        const pageHeightPx = Math.round(pageH * pxPerMm);

        let offsetY = 0;
        let pageNum = 0;

        while (offsetY < canvas.height) {
            if (pageNum > 0) doc.addPage();
            const sliceH = Math.min(pageHeightPx, canvas.height - offsetY);

            const slice = document.createElement('canvas');
            slice.width = canvas.width;
            slice.height = pageHeightPx;

            const ctx = slice.getContext('2d')!;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, slice.width, slice.height);
            ctx.drawImage(canvas, 0, offsetY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);

            doc.addImage(slice.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, pageW, pageH);

            offsetY += pageHeightPx;
            pageNum++;
        }

        addPageNumbers(doc, options.locale, pageW, pageH, 20);
        return output(doc, options.title, action);

    } catch (err) {
        if (document.body.contains(container)) document.body.removeChild(container);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Shared output helpers
// ---------------------------------------------------------------------------
function addPageNumbers(doc: any, locale: Locale, pageWidth: number, pageHeight: number, margin: number): void {
    const total = doc.getNumberOfPages();
    const pageLabel = t('pdf.page', locale);
    const ofLabel = t('pdf.of', locale);
    for (let i = 1; i <= total; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(160, 160, 160);
        doc.text(`${pageLabel} ${i} ${ofLabel} ${total}`, pageWidth - margin, pageHeight - 10, { align: 'right' });
    }
}

function output(doc: any, title: string, action: 'save' | 'blob'): string | void {
    const safeTitle = title
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, '_')
        .substring(0, 50) || 'notes';

    if (action === 'blob') return doc.output('bloburl').toString() + `#filename=${safeTitle}.pdf`;
    doc.save(`${safeTitle}.pdf`);
}

// ---------------------------------------------------------------------------
// VECTOR PATH: markdown AST -> jsPDF text and paths (searchable, small)
// ---------------------------------------------------------------------------
async function generatePdfLatin(options: PdfOptions, blocks: Block[], action: 'save' | 'blob'): Promise<string | void> {
    const { title, date, duration, style } = options;
    const config = STYLES[style] || STYLES.minimalista;

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.setProperties({ title, subject: 'CompendiumNotes', author: 'CompendiumNotes', creator: 'CompendiumNotes' });

    // Embed before measuring: getTextWidth() must report the metrics of the
    // font that actually ships inside the PDF, or the wrapping computed here
    // is not the wrapping the reader's viewer shows.
    const [embedded, monoEmbedded] = await Promise.all([
        registerFontFamily(doc, config.embedFamily),
        registerFontFamily(doc, 'LiberationMono'),
    ]);
    const fontTitle = embedded ? config.embedFamily : config.fallbackFont;
    const fontBody = fontTitle;
    const fontMono = monoEmbedded ? 'LiberationMono' : 'courier';

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 20;
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    const cornellRule = (from: number) => {
        doc.setDrawColor(209, 213, 219);
        doc.setLineWidth(0.3);
        doc.line(margin + 50, from, margin + 50, pageHeight - margin);
    };

    // Header
    if (config.headerBg && style === 'cornell') {
        doc.setFillColor(...config.headerColor!);
        doc.rect(0, 0, pageWidth, 55, 'F');
        y = 16;
    }

    doc.setFont(fontTitle, 'bold');
    doc.setFontSize(style === 'academico' ? 22 : style === 'cornell' ? 26 : 24);
    doc.setTextColor(...config.primaryColor);
    const titleLines = doc.splitTextToSize(title, contentWidth);
    doc.text(titleLines, margin, y);
    y += titleLines.length * (style === 'academico' ? 8.5 : 10) + 3;

    doc.setFont(fontBody, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...config.metaColor);
    let metaText = date;
    if (duration) metaText += `  \u2022  ${duration}`;
    metaText += '  \u2022  Compendium Notes';
    doc.text(metaText, margin, y);
    y += 5;

    if (config.lineSeparator) {
        doc.setDrawColor(...config.primaryColor);
        doc.setLineWidth(0.6);
        doc.line(margin, y, pageWidth - margin, y);
        y += 10;
    } else if (style === 'minimalista') {
        doc.setDrawColor(200, 200, 200);
        doc.setLineWidth(0.4);
        doc.line(margin, y, pageWidth - margin, y);
        y += 10;
    } else {
        y += 8;
    }

    if (style === 'cornell') {
        if (y < 60) y = 60;
        cornellRule(y);
    }

    const mathQueue: QueuedMath[] = [];
    const baseSize = style === 'academico' ? 11 : 10;

    const ctx: RenderContext = {
        doc,
        fontBody,
        fontTitle,
        fontMono,
        mathQueue,
        pageHeight,
        margin,
        state: { y },
        onNewPage: style === 'cornell' && config.leftColumn ? () => cornellRule(margin) : undefined,
        baseSize,
        lineHeight: baseSize * 0.5,
        primaryColor: config.primaryColor,
        accentColor: config.accentColor,
    };

    if (style === 'cornell') {
        // Cornell keeps headings in the cue column and prose in the wide one.
        for (const block of blocks) {
            if (block.type === 'heading' && block.level >= 2) {
                renderBlocks(ctx, [block], margin, 45);
            } else {
                renderBlocks(ctx, [block], margin + 55, contentWidth - 55);
            }
        }
    } else {
        renderBlocks(ctx, blocks, margin, contentWidth);
    }

    // Formulas were only measured during layout; draw them now.
    await drawMathQueue(doc, mathQueue);

    addPageNumbers(doc, options.locale, pageWidth, pageHeight, margin);
    return output(doc, title, action);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function generatePdf(
    options: PdfOptions,
    action: 'save' | 'blob' = 'save'
): Promise<string | void> {
    const blocks = options.isPlainText
        ? plainTextBlocks(options.content)
        : parseMarkdown(joinDisplayMathBlocks(options.content));

    // Resolve every formula up front so layout can stay synchronous.
    await preRenderMath(collectMathFromBlocks(blocks));

    if (requiresLayoutEngine(options.title + ' ' + options.content)) {
        return generatePdfViaCanvas(options, blocks, action);
    }

    return generatePdfLatin(options, blocks, action);
}

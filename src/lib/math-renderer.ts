// ---------------------------------------------------------------------------
// TeX -> SVG, for both PDF paths.
//
// MathJax is configured with fontCache:'none', which emits every glyph as a
// <path> outline instead of a <use> reference into a font. That matters twice:
// the math needs no embedded font at all, and svg2pdf can turn it into real
// vector drawing operations rather than a bitmap.
//
// MathJax renders malformed TeX as a visible error node instead of throwing,
// so a bad formula from the model costs one ugly expression, never the PDF.
// ---------------------------------------------------------------------------

export interface RenderedMath {
    svg: string;
    /** Intrinsic size, in ex units of the surrounding text. */
    widthEx: number;
    heightEx: number;
    /** Baseline offset in ex; negative means the box hangs below the baseline. */
    verticalAlignEx: number;
    display: boolean;
}

type MathJaxDoc = { convert(tex: string, opts: { display: boolean }): unknown };
type Adaptor = { outerHTML(node: unknown): string };

let enginePromise: Promise<{ doc: MathJaxDoc; adaptor: Adaptor }> | null = null;

async function getEngine() {
    if (enginePromise) return enginePromise;

    enginePromise = (async () => {
        const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }] =
            await Promise.all([
                import('mathjax-full/js/mathjax.js'),
                import('mathjax-full/js/input/tex.js'),
                import('mathjax-full/js/output/svg.js'),
                import('mathjax-full/js/adaptors/liteAdaptor.js'),
                import('mathjax-full/js/handlers/html.js'),
                import('mathjax-full/js/input/tex/AllPackages.js'),
            ]);

        const adaptor = liteAdaptor();
        RegisterHTMLHandler(adaptor as never);

        const doc = mathjax.document('', {
            InputJax: new TeX({ packages: AllPackages }),
            OutputJax: new SVG({ fontCache: 'none' }),
        });

        return { doc: doc as unknown as MathJaxDoc, adaptor: adaptor as unknown as Adaptor };
    })();

    return enginePromise;
}

const cache = new Map<string, RenderedMath | null>();

function parseEx(value: string | undefined): number {
    if (!value) return 0;
    const m = value.match(/(-?[\d.]+)ex/);
    return m ? parseFloat(m[1]) : 0;
}

/**
 * Renders one TeX expression. Returns null when MathJax is unavailable or the
 * expression cannot be converted at all, letting the caller print the raw TeX
 * rather than lose the document.
 */
export async function renderMath(tex: string, display: boolean): Promise<RenderedMath | null> {
    const key = `${display ? 'D' : 'I'}:${tex}`;
    if (cache.has(key)) return cache.get(key)!;

    let result: RenderedMath | null = null;
    try {
        const { doc, adaptor } = await getEngine();
        const html = adaptor.outerHTML(doc.convert(tex, { display }));

        // MathJax wraps its output in <mjx-container>. Strip it: svg2pdf needs
        // the <svg> element itself, and a data: URI of image/svg+xml is only
        // valid if <svg> is the root.
        const open = html.indexOf('<svg');
        const close = html.lastIndexOf('</svg>');
        if (open === -1 || close === -1) throw new Error('MathJax returned no <svg>');
        const svg = html.slice(open, close + '</svg>'.length);

        result = {
            svg,
            widthEx: parseEx(svg.match(/width="([^"]*)"/)?.[1]),
            heightEx: parseEx(svg.match(/height="([^"]*)"/)?.[1]),
            verticalAlignEx: parseEx(svg.match(/vertical-align:\s*([^;"]*)/)?.[1]),
            display,
        };
    } catch (err) {
        console.warn('[pdf] Math rendering failed, printing raw TeX.', tex, err);
        result = null;
    }

    cache.set(key, result);
    return result;
}

/** Pre-renders every expression so the layout pass can stay synchronous. */
export async function preRenderMath(items: { tex: string; display: boolean }[]): Promise<void> {
    await Promise.all(items.map(({ tex, display }) => renderMath(tex, display)));
}

/** Synchronous lookup, valid only after preRenderMath has resolved. */
export function getRenderedMath(tex: string, display: boolean): RenderedMath | null {
    return cache.get(`${display ? 'D' : 'I'}:${tex}`) ?? null;
}

export function __clearMathCache(): void {
    cache.clear();
}

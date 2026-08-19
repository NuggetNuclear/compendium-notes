import type jsPDF from 'jspdf';

// ---------------------------------------------------------------------------
// Font embedding for the jsPDF vector path.
//
// jsPDF's built-in Helvetica/Times/Courier are the PDF "standard 14": the spec
// lets them go unembedded, so every viewer substitutes its own face. Chrome's
// PDFium picks metrics-compatible clones and looks right, while Acrobat,
// Evince or Preview pick something else — different glyph widths, therefore
// different wrapping than the one we computed with getTextWidth().
// That is why the downloaded file used to disagree with the preview.
//
// Liberation Sans/Serif are metric-compatible with Helvetica/Times, so
// embedding them keeps the existing layout while making the file
// self-contained. They also add Latin-Ext, Greek, Cyrillic and Hebrew.
// ---------------------------------------------------------------------------

export type PdfFontFamily = 'LiberationSans' | 'LiberationSerif' | 'LiberationMono';

type FontStyle = 'normal' | 'bold' | 'italic';

const FONT_FILES: Record<PdfFontFamily, Record<FontStyle, string>> = {
    LiberationSans: {
        normal: 'LiberationSans-Regular.ttf',
        bold: 'LiberationSans-Bold.ttf',
        italic: 'LiberationSans-Italic.ttf',
    },
    LiberationSerif: {
        normal: 'LiberationSerif-Regular.ttf',
        bold: 'LiberationSerif-Bold.ttf',
        italic: 'LiberationSerif-Italic.ttf',
    },
    LiberationMono: {
        normal: 'LiberationMono-Regular.ttf',
        bold: 'LiberationMono-Bold.ttf',
        italic: 'LiberationMono-Italic.ttf',
    },
};

const FONT_BASE_PATH = '/fonts/';

// Base64 payloads are ~550KB per face; keep them for the session so a second
// PDF of the same style costs nothing.
const base64Cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    // Chunked: String.fromCharCode(...bytes) blows the argument limit at ~100KB.
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

async function loadFontBase64(file: string): Promise<string> {
    const cached = base64Cache.get(file);
    if (cached) return cached;

    const pending = inFlight.get(file);
    if (pending) return pending;

    const request = (async () => {
        const res = await fetch(`${FONT_BASE_PATH}${file}`);
        if (!res.ok) throw new Error(`Font fetch failed: ${file} (${res.status})`);
        const base64 = toBase64(await res.arrayBuffer());
        base64Cache.set(file, base64);
        return base64;
    })();

    inFlight.set(file, request);
    try {
        return await request;
    } finally {
        inFlight.delete(file);
    }
}

/**
 * Registers every style of `family` into `doc`.
 *
 * Returns true when the family is ready to use. Returns false if the fonts
 * could not be loaded (offline with a cold HTTP cache, asset missing), in
 * which case the caller must fall back to a built-in font: a slightly
 * inconsistent PDF beats no PDF at all.
 */
export async function registerFontFamily(doc: jsPDF, family: PdfFontFamily): Promise<boolean> {
    const files = FONT_FILES[family];
    if (!files) return false;

    try {
        const entries = Object.entries(files) as [FontStyle, string][];
        const loaded = await Promise.all(
            entries.map(async ([style, file]) => [style, file, await loadFontBase64(file)] as const)
        );

        for (const [style, file, base64] of loaded) {
            doc.addFileToVFS(file, base64);
            doc.addFont(file, family, style);
        }
        return true;
    } catch (err) {
        console.warn(`[pdf] Could not embed ${family}, falling back to a built-in font.`, err);
        return false;
    }
}

/** Test seam: drop cached payloads so each case starts clean. */
export function __clearFontCache(): void {
    base64Cache.clear();
    inFlight.clear();
}

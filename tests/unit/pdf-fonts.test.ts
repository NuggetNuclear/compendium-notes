import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import jsPDF from 'jspdf';
import { registerFontFamily, __clearFontCache } from '../../src/lib/pdf-fonts';

const PUBLIC_FONTS = join(process.cwd(), 'public', 'fonts');

/** Serves /fonts/*.ttf from public/, the way the dev server and Vercel do. */
function serveFontsFromDisk() {
    return vi.fn(async (url: string) => {
        const file = String(url).replace('/fonts/', '');
        try {
            const buf = await readFile(join(PUBLIC_FONTS, file));
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            };
        } catch {
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        }
    });
}

describe('registerFontFamily', () => {
    beforeEach(() => {
        __clearFontCache();
        vi.stubGlobal('fetch', serveFontsFromDisk());
    });

    it('registers all three styles so setFont() never silently falls back', async () => {
        const doc = new jsPDF();
        const ok = await registerFontFamily(doc, 'LiberationSans');

        expect(ok).toBe(true);
        expect(doc.getFontList()['LiberationSans']).toEqual(
            expect.arrayContaining(['normal', 'bold', 'italic'])
        );
    });

    it('embeds the face in the output, which is what makes viewers agree', async () => {
        const doc = new jsPDF();
        await registerFontFamily(doc, 'LiberationSerif');
        doc.setFont('LiberationSerif', 'normal');
        doc.text('Análisis Matemático — ελληνικά — кириллица', 10, 10);

        const bytes = doc.output('arraybuffer');
        const raw = Buffer.from(bytes).toString('latin1');

        // A FontFile2 entry is the embedded TrueType program itself. Without it
        // the viewer substitutes, and substitution is the bug we are fixing.
        expect(raw).toContain('FontFile2');
        expect(raw).toContain('LiberationSerif');
    });

    it('reports failure instead of throwing when the assets are missing', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const doc = new jsPDF();
        await expect(registerFontFamily(doc, 'LiberationSans')).resolves.toBe(false);

        warn.mockRestore();
    });

    it('fetches each face once across documents', async () => {
        const fetchMock = serveFontsFromDisk();
        vi.stubGlobal('fetch', fetchMock);

        await registerFontFamily(new jsPDF(), 'LiberationSans');
        await registerFontFamily(new jsPDF(), 'LiberationSans');

        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});

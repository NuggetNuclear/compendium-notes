// @vitest-environment jsdom
import { it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generatePdf } from '../../src/lib/pdf-generator';

const captured = vi.hoisted(() => ({ docs: [] as any[] }));

vi.mock('jspdf', async () => {
    const actual: any = await vi.importActual('jspdf');
    const Real = actual.default ?? actual.jsPDF;
    class Wrapped extends Real {
        constructor(...args: any[]) { super(...args); captured.docs.push(this); }
    }
    return { ...actual, default: Wrapped, jsPDF: Wrapped };
});

const NOTE = `# Cálculo Integral

Texto normal con **negrita**, *cursiva*, \`código inline\` y ~~tachado~~.

La energía en reposo es $E = mc^2$, y el curso cuesta $50 con $30 de libro.

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

## Tabla de símbolos

| Símbolo | Significado | Valor |
|---------|-------------|-------|
| $\\alpha$ | ángulo | 30° |
| $\\pi$ | razón | 3.1416 |

### Pasos ordenados

1. Derivar $f'(x) = 2x$
2. Integrar
    - Sustitución
    - Por partes
3. Verificar

> Una cita con matemática inline $\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$ dentro.

\`\`\`python
def gaussiana(x, mu=0, sigma=1):
    return exp(-((x - mu) ** 2) / (2 * sigma ** 2))
\`\`\`

Texto griego y cirílico: κείμενο, кириллица, ελληνικά.
`;

// Development aid: SAMPLE_OUT=/tmp/x.pdf npx vitest run tests/unit/emit-sample.test.ts
it.skipIf(!process.env.SAMPLE_OUT)('emits a sample PDF for visual inspection', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const buf = await readFile(join(process.cwd(), 'public', 'fonts', String(url).replace('/fonts/', '')));
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }));
    vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: () => 'blob:test' }));

    await generatePdf(
        { title: 'C\u00e1lculo Integral', date: '19/08/2026', content: NOTE, style: 'minimalista', locale: 'es' },
        'blob'
    );

    const doc = captured.docs[captured.docs.length - 1];
    writeFileSync(process.env.SAMPLE_OUT!, Buffer.from(doc.output('arraybuffer')));
}, 60000);

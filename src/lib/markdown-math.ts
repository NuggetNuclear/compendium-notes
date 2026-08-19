import MarkdownIt from 'markdown-it';

type Md = InstanceType<typeof MarkdownIt>;

// ---------------------------------------------------------------------------
// Math tokenization.
//
// A plain regex over the source cannot tell "$x^2$" from "costs $5 and $10" —
// and prices are far more common than formulas in a lecture note. These are
// real markdown-it inline/block rules, so they respect escaping (\$), skip
// code spans and fenced blocks, and apply the usual delimiter constraints:
// an opening $ may not be followed by whitespace, a closing $ may not be
// preceded by whitespace nor followed by a digit.
// ---------------------------------------------------------------------------

export type Segment =
    | { kind: 'text'; value: string }
    | { kind: 'math'; tex: string; display: boolean };

function isEscaped(src: string, pos: number): boolean {
    let backslashes = 0;
    for (let i = pos - 1; i >= 0 && src[i] === '\\'; i--) backslashes++;
    return backslashes % 2 === 1;
}

function inlineMath(state: any, silent: boolean): boolean {
    const src: string = state.src;
    const start = state.pos;

    if (src[start] !== '$' || isEscaped(src, start)) return false;

    // "$$" inline is display math; handled by the block rule when on its own
    // line, but it can also appear mid-paragraph.
    const isDisplay = src[start + 1] === '$';
    const delim = isDisplay ? '$$' : '$';
    const contentStart = start + delim.length;

    if (!isDisplay) {
        const next = src[contentStart];
        // "$ x$" and "$" at end are not math; "$5" is a price.
        if (next === undefined || /\s/.test(next)) return false;
    }

    let pos = contentStart;
    let end = -1;
    while (pos < src.length) {
        const idx = src.indexOf(delim, pos);
        if (idx === -1) break;
        if (isEscaped(src, idx)) { pos = idx + 1; continue; }
        if (!isDisplay) {
            const prev = src[idx - 1];
            const after = src[idx + delim.length];
            // Closing $ must not follow whitespace, and "$10" must not close "$5".
            if (prev === undefined || /\s/.test(prev) || (after !== undefined && /\d/.test(after))) {
                pos = idx + 1;
                continue;
            }
        }
        end = idx;
        break;
    }

    if (end === -1) return false;

    const tex = src.slice(contentStart, end).trim();
    if (!tex) return false;

    if (!silent) {
        const token = state.push('math', 'math', 0);
        token.content = tex;
        token.markup = delim;
        token.meta = { display: isDisplay };
    }

    state.pos = end + delim.length;
    return true;
}

export function mathPlugin(md: Md): void {
    md.inline.ruler.before('escape', 'math', inlineMath);
}

let mdInstance: Md | null = null;

function getMd(): Md {
    if (!mdInstance) {
        mdInstance = new MarkdownIt({ html: false, breaks: false, linkify: false });
        mdInstance.use(mathPlugin);
    }
    return mdInstance;
}

/**
 * Splits one line of markdown into literal text and math segments, leaving all
 * other markdown (bold markers included) untouched for the existing renderers.
 */
export function splitMath(line: string): Segment[] {
    const md = getMd();
    const tokens = md.parseInline(line, {});
    const children = tokens[0]?.children ?? [];

    const segments: Segment[] = [];
    let buffer = '';

    const flush = () => {
        if (buffer) { segments.push({ kind: 'text', value: buffer }); buffer = ''; }
    };

    for (const token of children) {
        if (token.type === 'math') {
            flush();
            segments.push({ kind: 'math', tex: token.content, display: !!(token as any).meta?.display });
        } else if (token.type === 'text') {
            buffer += token.content;
        } else if (token.type.endsWith('_open') || token.type.endsWith('_close')) {
            // Reconstruct the original source: the downstream renderers still
            // expect raw "**bold**" markers. Open and close each carry the
            // full markup, so emit it once per token, not once per pair.
            buffer += token.markup || '';
        } else if (token.markup) {
            buffer += token.markup + (token.content || '') + token.markup;
        } else {
            buffer += token.content || '';
        }
    }
    flush();

    return segments.length ? segments : [{ kind: 'text', value: line }];
}

/** Every distinct expression in a document, for the pre-render pass. */
export function collectMath(lines: string[]): { tex: string; display: boolean }[] {
    const seen = new Set<string>();
    const out: { tex: string; display: boolean }[] = [];
    for (const line of lines) {
        for (const seg of splitMath(line)) {
            if (seg.kind !== 'math') continue;
            const key = `${seg.display ? 'D' : 'I'}:${seg.tex}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ tex: seg.tex, display: seg.display });
        }
    }
    return out;
}

/**
 * Folds a fenced display block
 *
 *     $$
 *     x = y
 *     $$
 *
 * onto a single line, which is the shape the line-oriented section parser and
 * the inline tokenizer both understand. Models emit this form constantly.
 */
export function joinDisplayMathBlocks(content: string): string {
    const lines = content.split('\n');
    const out: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '$$') { out.push(lines[i]); continue; }

        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j].trim() !== '$$') { body.push(lines[j].trim()); j++; }

        // Unterminated fence: leave the source untouched rather than eat it.
        if (j >= lines.length) { out.push(lines[i]); continue; }

        out.push(`$$${body.join(' ')}$$`);
        i = j;
    }

    return out.join('\n');
}

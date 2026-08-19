import MarkdownIt from 'markdown-it';
import { mathPlugin } from './markdown-math';

type Md = InstanceType<typeof MarkdownIt>;

// ---------------------------------------------------------------------------
// One markdown AST, consumed by both PDF renderers.
//
// This replaces a line-oriented parser that only understood headings, bullets,
// blockquotes and "**". Everything downstream now works from real tokens, so
// tables, fenced code, nested lists, ordered lists and inline emphasis all
// survive into the PDF instead of leaking their source markers.
// ---------------------------------------------------------------------------

export interface InlineStyle {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strike?: boolean;
}

export type Inline =
    | { kind: 'text'; value: string; style: InlineStyle }
    | { kind: 'math'; tex: string; display: boolean };

export type Block =
    | { type: 'heading'; level: number; inlines: Inline[] }
    | { type: 'paragraph'; inlines: Inline[] }
    | { type: 'mathBlock'; tex: string }
    | { type: 'code'; text: string; lang?: string }
    | { type: 'quote'; blocks: Block[] }
    | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
    | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
    | { type: 'rule' };

let md: Md | null = null;

function getMd(): Md {
    if (!md) {
        md = new MarkdownIt({ html: false, linkify: false, breaks: false });
        md.use(mathPlugin);
    }
    return md;
}

// --- inline ----------------------------------------------------------------

function flattenInline(tokens: any[]): Inline[] {
    const out: Inline[] = [];
    const style: InlineStyle = {};
    const stack: (keyof InlineStyle)[] = [];

    const push = (value: string) => {
        if (!value) return;
        const last = out[out.length - 1];
        // Merge adjacent runs that share styling; keeps the layout loop short.
        if (last && last.kind === 'text' && sameStyle(last.style, style)) {
            last.value += value;
            return;
        }
        out.push({ kind: 'text', value, style: { ...style } });
    };

    for (const token of tokens) {
        switch (token.type) {
            case 'text': push(token.content); break;
            case 'math':
                out.push({ kind: 'math', tex: token.content, display: !!token.meta?.display });
                break;
            case 'code_inline':
                out.push({ kind: 'text', value: token.content, style: { ...style, code: true } });
                break;
            case 'softbreak': push(' '); break;
            case 'hardbreak': push(' '); break;
            case 'strong_open': stack.push('bold'); style.bold = true; break;
            case 'em_open': stack.push('italic'); style.italic = true; break;
            case 's_open': stack.push('strike'); style.strike = true; break;
            case 'strong_close':
            case 'em_close':
            case 's_close': {
                const key = stack.pop();
                if (key) delete style[key];
                break;
            }
            // Links keep their label; the URL is noise in a printed note.
            case 'link_open':
            case 'link_close':
                break;
            case 'image':
                push(token.content);
                break;
            default:
                if (token.children) out.push(...flattenInline(token.children));
                else if (token.content) push(token.content);
        }
    }

    return out;
}

function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
    return !!a.bold === !!b.bold && !!a.italic === !!b.italic
        && !!a.code === !!b.code && !!a.strike === !!b.strike;
}

// --- blocks ----------------------------------------------------------------

function parseBlocks(tokens: any[], i: { v: number }, stopAt?: string): Block[] {
    const blocks: Block[] = [];

    while (i.v < tokens.length) {
        const token = tokens[i.v];
        if (stopAt && token.type === stopAt) { i.v++; break; }

        switch (token.type) {
            case 'heading_open': {
                const level = parseInt(token.tag.slice(1), 10) || 1;
                const inlines = flattenInline(tokens[i.v + 1]?.children ?? []);
                blocks.push({ type: 'heading', level, inlines });
                i.v += 3;
                break;
            }
            case 'paragraph_open': {
                const inlines = flattenInline(tokens[i.v + 1]?.children ?? []);
                i.v += 3;
                // A paragraph holding nothing but display math is a block.
                const only = inlines.filter(n => !(n.kind === 'text' && !n.value.trim()));
                if (only.length === 1 && only[0].kind === 'math' && only[0].display) {
                    blocks.push({ type: 'mathBlock', tex: only[0].tex });
                } else if (inlines.length) {
                    blocks.push({ type: 'paragraph', inlines });
                }
                break;
            }
            case 'fence':
            case 'code_block':
                blocks.push({ type: 'code', text: token.content.replace(/\n$/, ''), lang: token.info?.trim() || undefined });
                i.v++;
                break;
            case 'hr':
                blocks.push({ type: 'rule' });
                i.v++;
                break;
            case 'blockquote_open': {
                i.v++;
                blocks.push({ type: 'quote', blocks: parseBlocks(tokens, i, 'blockquote_close') });
                break;
            }
            case 'bullet_list_open':
            case 'ordered_list_open': {
                const ordered = token.type === 'ordered_list_open';
                const start = parseInt(token.attrGet?.('start') ?? '1', 10) || 1;
                const close = ordered ? 'ordered_list_close' : 'bullet_list_close';
                i.v++;
                const items: Block[][] = [];
                while (i.v < tokens.length && tokens[i.v].type !== close) {
                    if (tokens[i.v].type === 'list_item_open') {
                        i.v++;
                        items.push(parseBlocks(tokens, i, 'list_item_close'));
                    } else {
                        i.v++;
                    }
                }
                i.v++;
                blocks.push({ type: 'list', ordered, start, items });
                break;
            }
            case 'table_open': {
                i.v++;
                const header: Inline[][] = [];
                const rows: Inline[][][] = [];
                let current: Inline[][] | null = null;
                let inHead = false;

                while (i.v < tokens.length && tokens[i.v].type !== 'table_close') {
                    const t = tokens[i.v];
                    if (t.type === 'thead_open') inHead = true;
                    else if (t.type === 'thead_close') inHead = false;
                    else if (t.type === 'tr_open') current = [];
                    else if (t.type === 'tr_close') {
                        if (current) { if (inHead) header.push(...current); else rows.push(current); }
                        current = null;
                    } else if (t.type === 'th_open' || t.type === 'td_open') {
                        current?.push(flattenInline(tokens[i.v + 1]?.children ?? []));
                        i.v += 2;
                    }
                    i.v++;
                }
                i.v++;
                blocks.push({ type: 'table', header, rows });
                break;
            }
            default:
                i.v++;
        }
    }

    return blocks;
}

export function parseMarkdown(content: string): Block[] {
    return parseBlocks(getMd().parse(content, {}), { v: 0 });
}

/** Plain-text mode: every line stays exactly as transcribed. */
export function plainTextBlocks(content: string): Block[] {
    return content.split('\n').map(line => ({
        type: 'paragraph' as const,
        inlines: [{ kind: 'text' as const, value: line, style: {} }],
    }));
}

/** Every distinct expression in the tree, for the math pre-render pass. */
export function collectMathFromBlocks(blocks: Block[]): { tex: string; display: boolean }[] {
    const seen = new Set<string>();
    const out: { tex: string; display: boolean }[] = [];

    const addInlines = (inlines: Inline[]) => {
        for (const n of inlines) {
            if (n.kind !== 'math') continue;
            add(n.tex, n.display);
        }
    };
    const add = (tex: string, display: boolean) => {
        const key = `${display ? 'D' : 'I'}:${tex}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ tex, display });
    };

    const walk = (list: Block[]) => {
        for (const b of list) {
            switch (b.type) {
                case 'heading':
                case 'paragraph': addInlines(b.inlines); break;
                case 'mathBlock': add(b.tex, true); break;
                case 'quote': walk(b.blocks); break;
                case 'list': b.items.forEach(walk); break;
                case 'table':
                    b.header.forEach(addInlines);
                    b.rows.forEach(r => r.forEach(addInlines));
                    break;
            }
        }
    };

    walk(blocks);
    return out;
}

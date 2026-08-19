import { getLanguageNameEn } from './languages';
import type { SummaryLevel } from './store';

/**
 * El prompt de los apuntes. Uno solo, para todos los proveedores.
 *
 * Existía dos veces. En Gemini estaba así, parametrizado por nivel. En Groq
 * seguían los tres textos originales —unas 150 líneas cada uno, iguales palabra
 * por palabra salvo en media docena de sitios— más un cuarto para las
 * continuaciones. El refactor se hizo en un lado y no en el otro, así que
 * cualquier arreglo del prompt había que hacerlo dos veces, y no se hacía: la
 * versión de Groq nunca recibió la regla que impide al modelo abrir con "Claro,
 * aquí tienes tus apuntes", ni el título en `#` que la app usa para nombrar el
 * proyecto.
 *
 * Lo que cambia entre proveedores es la red —cómo se manda la petición y qué
 * límites tiene—, no lo que se le pide al modelo.
 */
const DEPTH: Record<SummaryLevel, {
    summary: string;
    concepts: string;
    body: string;
    /** Secciones opcionales, en orden, después del cuerpo. */
    extras: string[];
    closing: string;
}> = {
    short: {
        summary: '3-5 bullet points with the most critical ideas. One or two lines each. No padding.',
        concepts: '5-8 concepts that are essential to follow the content, one precise line each.',
        body: '2-3 focused paragraphs per section: the main idea, the key arguments, and any example or figure mentioned.',
        extras: [],
        closing: 'Be compact but complete: compress ideas, never drop them.',
    },
    medium: {
        summary: '3-5 paragraphs of 3-4 lines synthesising the whole content: main argument, key findings, conclusions.',
        concepts: '6-12 concepts, two lines each: what it is and why it matters.',
        body: '2-4 paragraphs per section developing the context, the detailed explanation, the evidence or examples given, and how it connects to the rest.',
        extras: [
            '## Review Questions\n\n5-10 questions with answers of 2-3 lines, covering the main ideas.\n\n1. **Q:** ...\n   **A:** ...',
        ],
        closing: 'Develop the ideas deeply enough that the document stands on its own without the audio. Use real paragraphs, not endless bullet lists.',
    },
    long: {
        summary: '4-6 dense paragraphs of at least 5 lines covering the complete content.',
        concepts: '8-15 concepts with one explanatory line each.',
        body: '4-8 paragraphs per section: context, full theoretical explanation, examples given, implications, and connections with other concepts. This is the core of the document and must be the longest part.',
        extras: [
            '## Examples and Applications\n\nDevelop every example mentioned in full. Do not summarise them.',
            '## Connections\n\n3-5 paragraphs explaining how the concepts relate to each other.',
            '## Review Questions\n\n10-20 questions with answers of 3-5 lines.\n\n1. **Q:** ...\n   **A:** ...',
        ],
        closing: 'Write at length: more developed detail makes a better document. Never describe the document itself.',
    },
};

/** Cuenta las secciones `##` que se esperan, para mover la barra al redactar. */
export const expectedSections = (level: SummaryLevel) => 4 + (DEPTH[level]?.extras.length ?? 0);

/** El fragmento `n` de `total` de una transcripción que no cabe en una petición. */
export interface NotesPart {
    index: number;
    total: number;
}

/**
 * Un único prompt, parametrizado por nivel, idioma y —si hace falta— parte.
 *
 * El idioma se repite arriba y abajo a propósito: el primer token que genera
 * el modelo es el título, y era justo ahí donde se olvidaba de traducir.
 *
 * `part` sólo lo usan los proveedores con una ventana de contexto pequeña, que
 * tienen que trocear la transcripción y coser el resultado. En esa segunda y
 * siguientes llamadas se piden únicamente las secciones de contenido: el
 * título, el resumen y los conceptos ya los escribió la primera.
 */
export function buildNotesPrompt(
    transcription: string,
    summaryLevel: SummaryLevel,
    outputLanguage: string,
    part?: NotesPart,
): string {
    const d = DEPTH[summaryLevel] ?? DEPTH.short;
    const auto = outputLanguage === 'auto';
    const lang = auto ? "the audio's original language" : getLanguageNameEn(outputLanguage);
    const LANG = lang.toUpperCase();

    const language = `LANGUAGE
Write EVERYTHING in ${LANG}: the title, every heading, every paragraph, every question.${auto ? '' : ' Translate the content; do not leave anything in the original language.'}
The headings below are English templates — translate them too.`;

    const noPreamble = 'No preamble, no "here are your notes", no closing remarks, no emoji.\nClean Markdown. **Bold** for technical terms. Code blocks for code.\nFix the obvious errors of spoken transcription (false starts, repeated words), but never invent content that is not in the transcript. If something is unclear in the audio, leave it out rather than guessing.\nAny mathematical notation (formulas, equations, variables with subscripts/superscripts, Greek letters) must be written as LaTeX wrapped in $ for inline math (e.g. $X(t)$, $a > 1$) or $$ on its own line for display equations (e.g. $$P(t) = \\frac{v^2(t)}{R}$$). Never write raw LaTeX commands like \\frac or \\int outside of $ delimiters.';

    // Continuación: sólo secciones de contenido, sin cabecera del documento.
    if (part && part.index > 0) {
        return `You are an expert at turning a lecture transcript into study notes.

${language}

This is part ${part.index + 1} of ${part.total} of a longer transcript. The title, summary and key concepts were already written from part 1. Write ONLY the content sections for this part, continuing naturally.
Do not write a title. Do not repeat the summary, the key concepts or the definitions.
${noPreamble}

STRUCTURE

### [MM:SS] [Section title]

${d.body}

---

TRANSCRIPT (part ${part.index + 1} of ${part.total}):
${transcription}

---
${d.closing}`;
    }

    const extras = d.extras.length ? `\n\n${d.extras.join('\n\n')}` : '';
    // Con la transcripción troceada, las secciones de cierre las escribe la
    // última llamada, no la primera: aquí sólo van si el texto cabe entero.
    const tail = part ? '' : `

## Definitions

Only terms that are defined in the audio or that would be unclear without a definition.

> **Term**: definition based on how it is used here.${extras}`;

    return `You are an expert at turning a lecture transcript into study notes.

${language}

OUTPUT
Your very first characters must be "# " followed by a descriptive title in ${lang}.
${noPreamble}

STRUCTURE

# [Title in ${lang}]

## Summary

${d.summary}

## Key Concepts

${d.concepts}
- **Concept**: explanation

## Content

Split the recording into its actual topics. One section per topic, in the order they were discussed:

### [MM:SS] [Section title]

${d.body}${tail}

---

TRANSCRIPT${part ? ` (part 1 of ${part.total})` : ''}:
${transcription}

---
${d.closing}
Remember: start immediately with the "# " title, written in ${LANG}.`;
}

/**
 * Separa el título del cuerpo de los apuntes.
 *
 * Los dos proveedores lo hacían por su cuenta y distinto: Groq buscaba primero
 * su propio `## Título`, que con el prompt compartido ya no existe. El modelo a
 * veces se salta el `#` y empieza por un `##`; en ese caso se usa como título,
 * pero NO se quita del cuerpo, porque ahí sí es una sección de verdad.
 */
export function splitTitle(notes: string): { title: string; body: string } {
    const h1 = notes.match(/^#\s+(.+)/m);
    if (h1) {
        return {
            title: h1[1].trim().replace(/\*\*/g, ''),
            body: notes.replace(/^#\s+.+\n+/, '').trim(),
        };
    }
    const h2 = notes.match(/^##\s+(.+)/m);
    if (h2) {
        return { title: h2[1].trim().replace(/^\d+\.\s*/, '').replace(/\*\*/g, ''), body: notes };
    }
    return { title: '', body: notes };
}

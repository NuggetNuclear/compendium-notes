import type { ProcessedAudio } from './audio-processor';
import type { SummaryLevel, Provider as ProviderId } from './store';
import type { StageId } from './progress';
import { progress, m } from './progress';

import {
    transcribeWithGemini, transcribeWithGeminiChunked, organizeNotesWithGemini,
    validateGeminiKey, GEMINI_TRANSCRIPTION_MODELS, DURATION_THRESHOLD_CHUNKING,
} from './gemini';
import {
    transcribeAudio, organizeNotes, validateGroqKey, GROQ_TRANSCRIPTION_MODELS,
} from './groq';

export type { ProviderId };

/**
 * Un proveedor es lo ÚNICO que cambia entre dos ejecuciones.
 *
 * Antes había dos flujos completos, `runGeminiFlow` y `runGroqFlow`, de unas
 * doscientas líneas cada uno y con el 95% del cuerpo idéntico palabra por
 * palabra: preparar el audio, transcribir, redactar, sacar el título, guardar
 * en la base de datos, sonar la campanita. Cada arreglo había que hacerlo dos
 * veces y no se hacía — el título, por ejemplo, se extraía con reglas distintas
 * en cada uno.
 *
 * Lo que de verdad distingue a un proveedor es lo que hay aquí dentro: cómo
 * manda el audio y cómo pide los apuntes. El resto del camino es uno solo.
 */
export interface TranscribeArgs {
    processed: ProcessedAudio;
    apiKey: string;
    /** Modelo ya validado contra ESTE proveedor. */
    model: string;
    /** Avance 0-1. `phase` distingue subida de transcripción para la barra. */
    onProgress: (p: number, phase: 'upload' | 'transcribe') => void;
}

export interface OrganizeArgs {
    transcription: string;
    apiKey: string;
    summaryLevel: SummaryLevel;
    outputLanguage: string;
    onStep: (step: number) => void;
}

export interface TranscriptionModel {
    id: string;
    label: string;
    desc: string;
}

export interface Provider {
    id: ProviderId;
    label: string;
    /** Modelos que ofrece el selector para este proveedor. */
    transcriptionModels: readonly TranscriptionModel[];
    /** Etapas de la barra. Gemini enseña la subida aparte cuando no trocea. */
    stagesFor(processed: ProcessedAudio): StageId[];
    validateKey(key: string): Promise<boolean>;
    transcribe(args: TranscribeArgs): Promise<{ text: string; tokensUsed: number }>;
    organize(args: OrganizeArgs): Promise<{ notes: string; tokensUsed: number }>;
}

/** ¿Va a trocear Gemini este audio? Decide si hay etapa de subida separada. */
const geminiWillChunk = (p: ProcessedAudio) =>
    (p.duration || 0) / 60 >= DURATION_THRESHOLD_CHUNKING;

const gemini: Provider = {
    id: 'gemini',
    label: 'Gemini',
    transcriptionModels: GEMINI_TRANSCRIPTION_MODELS,

    stagesFor: (p) => geminiWillChunk(p)
        // Con fragmentos, cada uno se sube por su cuenta: no hay una etapa de
        // subida que enseñar por separado.
        ? ['prepare', 'transcribe', 'organize']
        : ['prepare', 'upload', 'transcribe', 'organize'],

    validateKey: validateGeminiKey,

    transcribe: ({ processed, apiKey, model, onProgress }) => geminiWillChunk(processed)
        ? transcribeWithGeminiChunked(
            processed.wasChunked ? processed.chunks : processed.chunks[0],
            apiKey,
            (p) => onProgress(p, 'transcribe'),
            processed.duration,
            processed.chunkMetadata,
            model,
        )
        : transcribeWithGemini(
            processed.chunks[0],
            apiKey,
            // El 50% del callback marca el final de la subida: a partir de ahí
            // el avance lo dictan los timestamps que emite el propio modelo.
            (p) => onProgress(p, p < 0.5 ? 'upload' : 'transcribe'),
            processed.duration || 0,
            0,
            model,
        ),

    organize: async ({ transcription, apiKey, summaryLevel, outputLanguage, onStep }) =>
        organizeNotesWithGemini(transcription, apiKey, onStep, summaryLevel, outputLanguage),
};

const groq: Provider = {
    id: 'groq',
    label: 'Groq',
    transcriptionModels: GROQ_TRANSCRIPTION_MODELS,

    // Whisper recibe los fragmentos ya cortados: nunca hay subida aparte.
    stagesFor: () => ['prepare', 'transcribe', 'organize'],

    validateKey: validateGroqKey,

    transcribe: async ({ processed, apiKey, model, onProgress }) => {
        // Whisper procesa en serie, así que el tablero necesita saber qué trozo
        // de audio cubre cada fragmento. Con troceado temporal los tiempos son
        // exactos; si no, se reparten por tamaño para que el tablero siga
        // diciendo algo útil ("fragmento 2 de 5").
        const totalSec = processed.duration || processed.chunks.length * 60;
        const chunkSeconds: number[] = [];
        let ranges: { startSec: number; endSec: number }[];

        if (processed.chunkMetadata?.length === processed.chunks.length) {
            ranges = processed.chunkMetadata.map((meta) => {
                chunkSeconds.push(meta.endTime - meta.startTime);
                return { startSec: meta.startTime, endSec: meta.endTime };
            });
        } else {
            const totalBytes = processed.chunks.reduce((sum, c) => sum + c.size, 0) || 1;
            let cursor = 0;
            ranges = processed.chunks.map((c) => {
                const span = totalSec * (c.size / totalBytes);
                const range = { startSec: cursor, endSec: cursor + span };
                chunkSeconds.push(span);
                cursor += span;
                return range;
            });
        }
        progress.initChunks(ranges);
        if (processed.chunks.length > 1) {
            progress.pushEvent('info', m(
                `Audio dividido en ${processed.chunks.length} fragmentos`,
                `Audio split into ${processed.chunks.length} chunks`,
            ));
        }

        const text = await transcribeAudio(
            processed.chunks, apiKey, (p) => onProgress(p, 'transcribe'), chunkSeconds, model,
        );
        // Whisper no informa de tokens; el contador vive para el resumen final.
        return { text, tokensUsed: 0 };
    },

    organize: async ({ transcription, apiKey, summaryLevel, outputLanguage, onStep }) => ({
        notes: await organizeNotes(transcription, apiKey, onStep, summaryLevel, outputLanguage),
        tokensUsed: 0,
    }),
};

const PROVIDERS: Record<ProviderId, Provider> = { gemini, groq };

export function providerFor(id: ProviderId): Provider {
    return PROVIDERS[id] ?? PROVIDERS.groq;
}

/**
 * Id de modelo válido para `provider`: el elegido si existe ahí, o `auto`.
 *
 * El selector guarda un único valor para los dos proveedores. Al cambiar de
 * proveedor ese valor dejaba de tener sentido pero seguía viajando en la
 * petición: un id de Gemini acababa en el endpoint de Whisper (400 "modelo no
 * soportado", error definitivo, transcripción entera perdida) y al revés (404
 * en Gemini). El desplegable, además, mostraba la primera opción como si
 * estuviera seleccionada, así que no había forma de darse cuenta.
 */
export function resolveTranscriptionModel(id: ProviderId, model: string | undefined | null): string {
    if (!model || model === 'auto') return 'auto';
    return providerFor(id).transcriptionModels.some((m) => m.id === model) ? model : 'auto';
}

/** Lo que ofrece el selector para el proveedor activo. */
export function transcriptionModelsFor(id: ProviderId): readonly TranscriptionModel[] {
    return providerFor(id).transcriptionModels;
}

import Dexie, { type Table } from 'dexie';

export interface Project {
    id?: number;
    title: string;
    createdAt: number;
    updatedAt: number;
    status: 'draft' | 'processing' | 'done' | 'cancelled' | 'error';
    /**
     * Veces que se ha intentado retomar este proyecto tras una recarga.
     *
     * Si el proceso mata la pestaña (memoria agotada), al volver a abrir la app
     * la sesión se restauraba y arrancaba otra vez el mismo trabajo, que volvía
     * a matarla: un bucle de reinicios del que no se salía sin borrar los datos
     * del sitio. Con un contador, se reintenta una vez y luego se para y se
     * explica.
     */
    resumeAttempts?: number;
}

export interface AudioSource {
    id?: number;
    projectId: number;
    file: Blob; // The raw audio file
    type: string;
    name: string;
}

export interface ProcessingState {
    id?: number;
    projectId: number;
    step: 'upload' | 'transcribing' | 'ai-processing' | 'editor';
    subStep: string; // 'compressing', 'uploading', 'analyzing'
    progress: number;
    transcription?: string;
    organizedNotes?: string;
    lastUpdated: number;
    metadata?: Record<string, any>;
}

export class CompendiumDB extends Dexie {
    projects!: Table<Project>;
    audioSource!: Table<AudioSource>;
    processingState!: Table<ProcessingState>;

    constructor() {
        super('CompendiumDB');
        this.version(1).stores({
            projects: '++id, status, updatedAt',
            audioSource: '++id, projectId', // Link to project
            processingState: '++id, projectId', // Link to project
            secrets: 'key' // Key-Value store for secrets
        });
        // v2: las API Keys ya no se cifran, así que no hay clave maestra que
        // guardar. Se borra la tabla en lugar de dejarla ahí con la clave de
        // un cifrado que ya no se usa.
        this.version(2).stores({ secrets: null });
    }
}

export const db = new CompendiumDB();

// Helper to create a new project
export async function createProject(title: string): Promise<number> {
    const id = await db.projects.add({
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'draft',
        resumeAttempts: 0
    });
    return id as number;
}

// Helper to save audio blob (heavy lifting)
export async function saveAudioSource(projectId: number, file: File) {
    // Clear existing audio for this project first (if any)
    await db.audioSource.where({ projectId }).delete();

    await db.audioSource.add({
        projectId,
        file: file,
        type: file.type,
        name: file.name
    });
}

// Helper to get the most recent active project
export async function getActiveProject() {
    // Find the last modified project that is NOT 'done' (optional logic, can be adjusted)
    // For now, let's just get the very last touched project
    const project = await db.projects.orderBy('updatedAt').reverse().first();
    if (!project) return null;

    const audio = await db.audioSource.where({ projectId: project.id! }).first();
    const state = await db.processingState.where({ projectId: project.id! }).first();

    return { project, audio, state };
}

// Helper to update processing state
export async function updateProjectState(
    projectId: number,
    updates: Partial<ProcessingState>
) {
    const existing = await db.processingState.where({ projectId }).first();
    if (existing) {
        await db.processingState.update(existing.id!, {
            ...updates,
            lastUpdated: Date.now()
        });
    } else {
        await db.processingState.add({
            projectId,
            step: 'upload',
            subStep: 'idle',
            progress: 0,
            lastUpdated: Date.now(),
            ...updates
        } as ProcessingState);
    }

    // Also touch the project to keep it fresh
    await db.projects.update(projectId, { updatedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Historial: lo que ya está guardado, listado para poder volver a ello
// ---------------------------------------------------------------------------

/**
 * Una entrada del historial: lo justo para pintar una fila.
 *
 * Deliberadamente NO lleva ni el audio ni los textos completos. La lista puede
 * tener cincuenta clases de dos horas; arrastrar cada transcripción entera
 * hasta el render sería cargar megas en memoria para enseñar "1.234 palabras".
 * Los textos se piden uno a uno, sólo cuando se abre esa entrada.
 */
export interface HistoryEntry {
    id: number;
    title: string;
    createdAt: number;
    updatedAt: number;
    status: Project['status'];
    /** Nombre y tamaño del audio original, si se conserva. */
    audio: { name: string; type: string; size: number } | null;
    hasTranscription: boolean;
    hasNotes: boolean;
    /** Palabras de los apuntes; 0 si no llegaron a generarse. */
    noteWords: number;
    /** Caracteres de la transcripción. */
    transcriptChars: number;
    provider?: string;
    durationMinutes?: string;
}

/** Todo lo guardado, de lo más reciente a lo más antiguo. */
export async function listHistory(): Promise<HistoryEntry[]> {
    const projects = await db.projects.orderBy('updatedAt').reverse().toArray();
    if (projects.length === 0) return [];

    const ids = projects.map((p) => p.id!).filter((id) => id !== undefined);
    const [audios, states] = await Promise.all([
        db.audioSource.where('projectId').anyOf(ids).toArray(),
        db.processingState.where('projectId').anyOf(ids).toArray(),
    ]);

    const audioBy = new Map(audios.map((a) => [a.projectId, a]));
    const stateBy = new Map(states.map((s) => [s.projectId, s]));

    return projects.map((p) => {
        const audio = audioBy.get(p.id!);
        const state = stateBy.get(p.id!);
        const notes = state?.organizedNotes ?? '';
        const transcript = state?.transcription ?? '';

        return {
            id: p.id!,
            title: p.title,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            status: p.status,
            // Del audio sólo viajan los metadatos: el Blob se queda en la base.
            audio: audio
                ? { name: audio.name, type: audio.type, size: Number(audio.file?.size) || 0 }
                : null,
            hasTranscription: transcript.trim().length > 0,
            hasNotes: notes.trim().length > 0,
            noteWords: notes.trim() ? notes.trim().split(/\s+/).length : 0,
            transcriptChars: transcript.length,
            provider: state?.metadata?.provider,
            durationMinutes: state?.metadata?.durationMinutes,
        };
    });
}

/** Todo lo de un proyecto: textos y audio rehidratado como `File`. */
export async function loadProject(projectId: number): Promise<{
    project: Project;
    file: File | null;
    transcription: string;
    organizedNotes: string;
} | null> {
    const project = await db.projects.get(projectId);
    if (!project) return null;

    const [audio, state] = await Promise.all([
        db.audioSource.where({ projectId }).first(),
        db.processingState.where({ projectId }).first(),
    ]);

    return {
        project,
        file: audio ? new File([audio.file], audio.name, { type: audio.type }) : null,
        transcription: state?.transcription ?? '',
        organizedNotes: state?.organizedNotes ?? '',
    };
}

/**
 * Borra un proyecto y todo lo que cuelga de él.
 *
 * Las tres tablas van juntas o no va ninguna: dejar el audio de un proyecto que
 * ya no existe es ocupar disco que nadie va a poder liberar desde la interfaz.
 */
export async function deleteProject(projectId: number): Promise<void> {
    await db.transaction('rw', db.projects, db.audioSource, db.processingState, async () => {
        await db.audioSource.where({ projectId }).delete();
        await db.processingState.where({ projectId }).delete();
        await db.projects.delete(projectId);
    });
}

/** Sólo el audio de un proyecto, para descargarlo o reproducirlo. */
export async function loadProjectAudio(projectId: number): Promise<File | null> {
    const audio = await db.audioSource.where({ projectId }).first();
    return audio ? new File([audio.file], audio.name, { type: audio.type }) : null;
}

/** Marca un proyecto como el último usado, sin tocar su contenido. */
export async function touchProject(projectId: number): Promise<void> {
    await db.projects.update(projectId, { updatedAt: Date.now() });
}

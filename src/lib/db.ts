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

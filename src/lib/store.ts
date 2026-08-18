import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppStep = 'upload' | 'transcribing' | 'ai-processing' | 'editor';
export type PdfStyle = 'minimalista' | 'academico' | 'cornell';
export type SummaryLevel = 'short' | 'medium' | 'long';
export type Locale = 'es' | 'en';
export type OutputLanguage = string;
export type Provider = 'groq' | 'gemini';
export type ProcessingState = 'idle' | 'compressing' | 'uploading' | 'transcribing' | 'analyzing' | 'done' | 'error';

interface AppState {
    // Language
    locale: Locale;
    setLocale: (locale: Locale) => void;

    // Provider
    provider: Provider;
    setProvider: (provider: Provider) => void;

    // API Keys (one per provider), en claro
    apiKey: string;       // Groq
    setApiKey: (key: string) => void;
    geminiKey: string;    // Gemini
    setGeminiKey: (key: string) => void;

    // Active key helper
    activeKey: () => string;

    // App step
    step: AppStep;
    setStep: (step: AppStep) => void;

    // File
    file: File | null;
    setFile: (file: File | null) => void;

    // Transcription
    transcription: string;
    setTranscription: (text: string) => void;
    transcriptionProgress: number;
    setTranscriptionProgress: (p: number) => void;

    // AI Processing
    aiStep: number;
    setAiStep: (step: number) => void;
    title: string; // Intelligent Title
    setTitle: (title: string) => void;
    organizedNotes: string;
    setOrganizedNotes: (notes: string) => void;

    // Editor
    editedNotes: string;
    setEditedNotes: (notes: string) => void;

    // PDF
    pdfStyle: PdfStyle;
    setPdfStyle: (style: PdfStyle) => void;

    // Summary Level
    summaryLevel: SummaryLevel;
    setSummaryLevel: (level: SummaryLevel) => void;

    // Output Language
    outputLanguage: OutputLanguage;
    setOutputLanguage: (lang: OutputLanguage) => void;

    // Transcription Model
    transcriptionModel: string;
    setTranscriptionModel: (model: string) => void;

    // Config
    configOpen: boolean;
    setConfigOpen: (open: boolean) => void;

    // Error
    error: string | null;
    setError: (err: string | null) => void;

    // Global Processing State
    processingState: ProcessingState;
    setProcessingState: (state: ProcessingState) => void;
    processingProgress: number; // 0-1
    setProcessingProgress: (p: number) => void;
    compressionInfo: string;
    setCompressionInfo: (info: string) => void;

    // Persistence (ID only)
    currentProjectId: number | null;
    setCurrentProjectId: (id: number | null) => void;

    // Actions
    startProcessing: (file: File) => void;
    cancelProcessing: () => void;
    retryProcessing: () => void;
    restoreSession: () => Promise<void>; // New Action

    // Theme
    theme: 'light' | 'dark';
    toggleTheme: () => void;

    // Reset
    reset: () => void;
}

function getInitialTheme(): 'light' | 'dark' {
    if (typeof window === 'undefined') return 'dark';
    const stored = localStorage.getItem('scn-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getInitialLocale(): Locale {
    if (typeof window === 'undefined') return 'es';
    const stored = localStorage.getItem('scn-lang');
    if (stored === 'en' || stored === 'es') return stored;
    return navigator.language.startsWith('en') ? 'en' : 'es';
}

function getInitialProvider(): Provider {
    if (typeof window === 'undefined') return 'groq';
    const stored = localStorage.getItem('scn-provider');
    if (stored === 'groq' || stored === 'gemini') return stored;
    return 'groq';
}

function getInitialOutputLanguage(): OutputLanguage {
    if (typeof window === 'undefined') return 'auto';
    const stored = localStorage.getItem('scn-output-lang');
    return stored || 'auto';
}

/** Veces que se reintenta retomar un proceso interrumpido antes de rendirse. */
const MAX_RESUME_ATTEMPTS = 1;

/**
 * Las API Keys se guardaban cifradas con AES-GCM… y la clave de cifrado vivía
 * en el mismo IndexedDB del navegador, al lado del texto cifrado. Quien pudiera
 * leer una podía leer la otra: no protegía de nada y costaba 126 líneas. Ahora
 * van en claro, que es lo que siempre fueron.
 *
 * Lo que quedara cifrado de antes ya no se puede leer, y mandarlo tal cual a la
 * API sólo daría un "API Key inválida" incomprensible. Se descarta una vez y se
 * vuelve a pedir.
 */
const KEYS_ARE_PLAIN = 'scn-keys-plain';

function readKey(name: string): string {
    if (typeof window === 'undefined') return '';
    if (!localStorage.getItem(KEYS_ARE_PLAIN)) {
        localStorage.removeItem('scn-api-key');
        localStorage.removeItem('scn-gemini-key');
        localStorage.setItem(KEYS_ARE_PLAIN, '1');
        return '';
    }
    return localStorage.getItem(name) || '';
}

function getInitialTranscriptionModel(): string {
    if (typeof window === 'undefined') return 'auto';
    const stored = localStorage.getItem('scn-transcription-model');
    return stored || 'auto';
}

// Import DB dynamically to avoid SSR issues if store is used there (though unlikely in standard React usage)
import { db, createProject, saveAudioSource, getActiveProject } from './db';
import { progress } from './progress';
import { abortRun } from './pipeline-control';

export const useAppStore = create<AppState>()(
    persist(
        (set, get) => ({
            theme: getInitialTheme(),
            toggleTheme: () => {
                const current = get().theme;
                const next = current === 'dark' ? 'light' : 'dark';
                if (typeof window !== 'undefined') {
                    localStorage.setItem('scn-theme', next);
                    document.documentElement.classList.toggle('dark', next === 'dark');
                }
                set({ theme: next });
            },

            locale: getInitialLocale(),
            setLocale: (locale) => {
                if (typeof window !== 'undefined') localStorage.setItem('scn-lang', locale);
                set({ locale });
            },

            provider: getInitialProvider(),
            setProvider: (provider) => {
                if (typeof window !== 'undefined') localStorage.setItem('scn-provider', provider);
                set({ provider });
            },

            outputLanguage: getInitialOutputLanguage(),
            setOutputLanguage: (outputLanguage) => {
                if (typeof window !== 'undefined') localStorage.setItem('scn-output-lang', outputLanguage);
                set({ outputLanguage });
            },

            transcriptionModel: getInitialTranscriptionModel(),
            setTranscriptionModel: (transcriptionModel) => {
                if (typeof window !== 'undefined') localStorage.setItem('scn-transcription-model', transcriptionModel);
                set({ transcriptionModel });
            },

            apiKey: readKey('scn-api-key'),
            setApiKey: (apiKey) => {
                if (typeof window !== 'undefined') {
                    if (apiKey) localStorage.setItem('scn-api-key', apiKey);
                    else localStorage.removeItem('scn-api-key');
                }
                set({ apiKey });
            },

            geminiKey: readKey('scn-gemini-key'),
            setGeminiKey: (geminiKey) => {
                if (typeof window !== 'undefined') {
                    if (geminiKey) localStorage.setItem('scn-gemini-key', geminiKey);
                    else localStorage.removeItem('scn-gemini-key');
                }
                set({ geminiKey });
            },

            activeKey: () => {
                const state = get();
                return (state.provider === 'gemini' ? state.geminiKey : state.apiKey) || '';
            },

            step: 'upload',
            setStep: (step) => set({ step }),

            file: null,
            setFile: (file) => set({ file }),

            transcription: '',
            setTranscription: (transcription) => set({ transcription }),
            transcriptionProgress: 0,
            setTranscriptionProgress: (transcriptionProgress) => set({ transcriptionProgress }),

            aiStep: 0,
            setAiStep: (aiStep) => set({ aiStep }),
            organizedNotes: '',
            setOrganizedNotes: (organizedNotes) => set({ organizedNotes, editedNotes: organizedNotes }),

            editedNotes: '',
            setEditedNotes: (editedNotes) => set({ editedNotes }),

            pdfStyle: 'minimalista',
            setPdfStyle: (pdfStyle) => set({ pdfStyle }),

            summaryLevel: 'short',
            setSummaryLevel: (summaryLevel) => set({ summaryLevel }),

            title: '',
            setTitle: (title) => set({ title }),

            configOpen: false,
            setConfigOpen: (configOpen) => set({ configOpen }),

            error: null,
            setError: (error) => set({ error }),

            processingState: 'idle',
            setProcessingState: (processingState) => set({ processingState }),
            processingProgress: 0,
            setProcessingProgress: (processingProgress) => set({ processingProgress }),
            compressionInfo: '',
            setCompressionInfo: (compressionInfo) => set({ compressionInfo }),

            currentProjectId: null,
            setCurrentProjectId: (id) => set({ currentProjectId: id }),

            startProcessing: async (file) => {
                const state = get();
                const key = state.activeKey();

                if (!key) {
                    console.warn('[Store] 🚫 Cannot start: Missing API Key');
                    set({
                        error: state.locale === 'es' ? 'Falta configurar la API Key' : 'API Key missing',
                        configOpen: true
                    });
                    return;
                }

                // Initialize DB Project
                try {
                    const id = await createProject(file.name);
                    await saveAudioSource(id, file);
                    // Explicitly mark as processing so restoreSession knows to resume it
                    await db.projects.update(id, { status: 'processing', resumeAttempts: 0 });

                    set({
                        currentProjectId: id,
                        file,
                        processingState: 'compressing',
                        processingProgress: 0,
                        step: 'transcribing',
                        compressionInfo: ''
                    });
                } catch (e) {
                    console.error('DB Error:', e);
                    // Fallback to memory
                    set({
                        file,
                        processingState: 'compressing',
                        processingProgress: 0,
                        step: 'transcribing',
                        compressionInfo: ''
                    });
                }
            },

            /**
             * Reintenta con el mismo archivo tras un fallo, sin obligar a
             * volver a la pantalla de subida ni a elegir el archivo otra vez.
             */
            retryProcessing: () => {
                const { file, currentProjectId } = get();
                if (!file) return;
                if (currentProjectId) {
                    db.projects.update(currentProjectId, { status: 'processing', resumeAttempts: 0 })
                        .catch(() => { /* informativo */ });
                }
                progress.resetIdle();
                set({
                    error: null,
                    processingState: 'compressing',
                    processingProgress: 0,
                    step: 'transcribing',
                    compressionInfo: '',
                });
            },

            cancelProcessing: async () => {
                // Primero cortar el trabajo, luego limpiar. Al revés, la
                // ejecución seguía viva contra la API y, al terminar, escribía
                // sus resultados encima de un estado ya reiniciado.
                abortRun();
                progress.resetIdle();
                const { currentProjectId } = get();
                if (currentProjectId) {
                    try {
                        await db.projects.update(currentProjectId, { status: 'cancelled' });
                    } catch (e) {
                        console.error('Failed to update project status:', e);
                    }
                }
                set({
                    processingState: 'idle',
                    processingProgress: 0,
                    file: null,
                    step: 'upload',
                    currentProjectId: null,
                    transcription: '',
                    organizedNotes: '',
                    editedNotes: '',
                    title: '',
                    compressionInfo: ''
                });
            },

            restoreSession: async () => {
                if (typeof window === 'undefined') return;
                try {
                    const active = await getActiveProject();
                    if (active && active.project.status !== 'cancelled') {
                        // Found a session (pending or completed)
                        console.log('Restoring session:', active.project.title, 'Status:', active.project.status);

                        // Rehydrate File
                        if (active.audio) {
                            const restoredFile = new File([active.audio.file], active.audio.name, { type: active.audio.type });
                            set({ file: restoredFile });
                        }

                        set({ currentProjectId: active.project.id });

                        // Note: The rest of the state (transcription, notes) is handled by zustand persist
                        // But we might need to nudge the GlobalAudioProcessor to resume if state was mid-process
                        if (active.project.status === 'processing') {
                            const key = get().activeKey();
                            if (!key) {
                                console.warn('Cannot resume: No API Key found');
                                // Reset project status in DB so it doesn't try again
                                await db.projects.update(active.project.id, { status: 'cancelled' });
                                return;
                            }

                            // Si ya se intentó retomar y la pestaña volvió a
                            // caer, insistir sólo repite el mismo desenlace.
                            const attempts = active.project.resumeAttempts ?? 0;
                            if (attempts >= MAX_RESUME_ATTEMPTS) {
                                console.warn('[Store] Reanudación abandonada tras', attempts, 'intentos');
                                await db.projects.update(active.project.id, { status: 'error' });
                                set({
                                    processingState: 'idle',
                                    step: 'upload',
                                    error: get().locale === 'es'
                                        ? 'El proceso anterior no pudo completarse dos veces seguidas, así que se ha detenido. Prueba con un archivo más corto o convierte el vídeo a audio antes de subirlo.'
                                        : 'The previous run failed twice in a row, so it has been stopped. Try a shorter file, or convert the video to audio before uploading.',
                                });
                                return;
                            }

                            console.log(`Auto-resuming interrupted process (intento ${attempts + 1}/${MAX_RESUME_ATTEMPTS})...`);
                            await db.projects.update(active.project.id, { resumeAttempts: attempts + 1 });
                            set({
                                processingState: 'compressing',
                                step: 'transcribing' // Force UI to show progress, not upload
                            });
                        }
                    }
                } catch (e) {
                    console.error('Failed to restore session:', e);
                }
            },

            reset: () => {
                abortRun();
                progress.resetIdle();
                // Clear persisted storage for content
                set({
                    step: 'upload',
                    file: null,
                    transcription: '',
                    transcriptionProgress: 0,
                    aiStep: 0,
                    organizedNotes: '',
                    editedNotes: '',
                    title: '',
                    error: null,
                    processingState: 'idle',
                    processingProgress: 0,
                    compressionInfo: '',
                    currentProjectId: null
                    // Keep keys, provider, locale, style, theme
                });
            },
        }),
        {
            name: 'scn-storage', // unique name
            partialize: (state) => ({
                step: state.step,
                transcription: state.transcription,
                organizedNotes: state.organizedNotes,
                editedNotes: state.editedNotes,
                title: state.title,
                pdfStyle: state.pdfStyle,
                summaryLevel: state.summaryLevel,
                // Don't persist file or big blobs here
            }),
        }
    )
);

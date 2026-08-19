import React, { useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Settings, X, Globe, Sun, Moon } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import { t } from '../../lib/i18n';
import UploadZone from './UploadZone';
import ConfigModal from './ConfigModal';
import ProcessingView from './ProcessingView';
import NotesEditor from './NotesEditor';
import HistoryPanel from './HistoryPanel';

// --- AJUSTE DE POSICIÓN VERTICAL ---
// Modifica estos valores para subir o bajar el contenido:
// Valores positivos bajan el contenido, valores negativos lo suben.
const PC_VERTICAL_OFFSET = "-80px";    // Ajuste para ordenador (ej: "-40px", "0px", "20px")
const MOBILE_VERTICAL_OFFSET = "-60px"; // Ajuste para teléfono
// ------------------------------------

export default function AppMain() {
    const { step, configOpen, setConfigOpen, historyOpen, setHistoryOpen, error, setError, apiKey, geminiKey, provider, locale, setLocale, processingState, theme, toggleTheme } = useAppStore();

    const isConnected = provider === 'gemini' ? !!geminiKey : !!apiKey;
    const providerLabel = provider === 'gemini' ? 'Gemini' : 'Groq';

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            setConfigOpen(!configOpen);
        }
    }, [configOpen, setConfigOpen]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    // Los errores se cierran a mano.
    //
    // Antes se borraban solos a los 5 s: un proceso que fallaba a los veinte
    // minutos dejaba un aviso que se desvanecía antes de que nadie lo leyera, y
    // el usuario se encontraba en la pantalla de subida sin saber por qué.

    // Browser navigation & Strict Guards (Unified)
    useEffect(() => {
        const syncAndCheck = () => {
            const currentStoreState = useAppStore.getState();
            const currentStep = currentStoreState.step;
            const hasNotes = !!currentStoreState.organizedNotes;
            const hasTrans = !!currentStoreState.transcription;
            const processingSt = currentStoreState.processingState;
            const isProcessing = ['compressing', 'uploading', 'transcribing', 'analyzing'].includes(processingSt);
            // Un proceso fallido conserva su pantalla: ahí está el registro que
            // explica qué salió mal y desde ahí se puede reintentar.
            const isFailed = processingSt === 'error';

            let correctedStep = currentStep;

            const urlParams = new URLSearchParams(window.location.search);
            const isNewRequest = urlParams.get('new') === 'true';

            if (isNewRequest && !isProcessing) {
                correctedStep = 'upload';
                // Remove the query param so it doesn't stick
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.delete('new');
                window.history.replaceState(history.state, '', newUrl.pathname + newUrl.hash);
            }

            // 1. Force progression if processing
            if (isProcessing && correctedStep === 'upload') {
                correctedStep = 'transcribing';
            }
            // 2. Force retreat if no data and idle
            else if (!hasNotes && !hasTrans && !isProcessing && !isFailed && (correctedStep === 'ai-processing' || correctedStep === 'editor' || correctedStep === 'transcribing')) {
                correctedStep = 'upload';
            }
            // 3. Prevent stuck in upload if data exists, UNLESS user explicitly requested upload via query param
            else if (hasNotes && correctedStep === 'upload' && !isNewRequest) {
                correctedStep = 'editor';
            }

            if (correctedStep !== currentStep) {
                // State correction: use replace to avoid polluting history with invalid states
                useAppStore.setState({ step: correctedStep });
                history.replaceState({ step: correctedStep }, '', `#${correctedStep}`);
            } else if (history.state?.step !== currentStep) {
                // State sync: store changed (start/done), sync history
                history.replaceState({ step: correctedStep }, '', `#${correctedStep}`);
            }
        };

        syncAndCheck();

        const handlePopState = (e: PopStateEvent) => {
            const s = e.state?.step;
            const currentStoreState = useAppStore.getState();
            const isProcessing = ['compressing', 'uploading', 'transcribing', 'analyzing'].includes(currentStoreState.processingState);

            if (s) {
                // Security: Block backtracking to upload while a heavy process is active
                if (isProcessing && s === 'upload') {
                    history.pushState({ step: currentStoreState.step }, '', `#${currentStoreState.step}`);
                    return;
                }

                // Convenience: Avoid revisiting loading screens once notes are ready
                if (!!currentStoreState.organizedNotes && (s === 'transcribing' || s === 'ai-processing')) {
                    history.pushState({ step: 'editor' }, '', '#editor');
                    useAppStore.setState({ step: 'editor' });
                    return;
                }

                useAppStore.setState({ step: s });
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, [step, processingState]);

    // Language & Theme Sync
    useEffect(() => {
        const handleLangChange = (e: any) => {
            if (e.detail && (e.detail === 'es' || e.detail === 'en')) setLocale(e.detail);
        };
        window.addEventListener('scn-lang-change' as any, handleLangChange);
        return () => window.removeEventListener('scn-lang-change' as any, handleLangChange);
    }, [setLocale]);

    const toggleLocale = () => {
        if ((window as any).toggleLang) {
            (window as any).toggleLang();
        } else {
            const next = locale === 'es' ? 'en' : 'es';
            setLocale(next);
            if ((window as any).applyLang) (window as any).applyLang(next);
        }
    };

    useEffect(() => {
        const handleThemeChange = (e: any) => {
            if (e.detail && (e.detail === 'light' || e.detail === 'dark')) {
                useAppStore.setState({ theme: e.detail });
            }
        };
        window.addEventListener('scn-theme-change' as any, handleThemeChange);
        return () => window.removeEventListener('scn-theme-change' as any, handleThemeChange);
    }, []);

    // Provider Badge Sync
    useEffect(() => {
        const label = document.getElementById('provider-label');
        const badge = document.getElementById('provider-badge');

        if (label && badge) {
            label.textContent = provider === 'gemini' ? 'Gemini' : 'Groq';
            if (!isConnected) {
                badge.style.display = 'none';
            } else {
                badge.style.display = 'flex';
                badge.style.background = 'rgba(16,185,129,0.1)';
                badge.style.color = '#34d399';
                badge.style.borderColor = 'rgba(16,185,129,0.3)';
                const indicator = badge.querySelector('span');
                if (indicator) indicator.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.5)]';
            }
        }
    }, [provider, isConnected]);

    useEffect(() => {
        const handleOpenConfig = () => setConfigOpen(true);
        window.addEventListener('scn-open-config' as any, handleOpenConfig);
        return () => window.removeEventListener('scn-open-config' as any, handleOpenConfig);
    }, [setConfigOpen]);

    // El botón vive en la barra de navegación, que es Astro y no comparte
    // estado con React: se comunica por evento, igual que la configuración.
    useEffect(() => {
        const handleOpenHistory = () => setHistoryOpen(true);
        window.addEventListener('scn-open-history' as any, handleOpenHistory);
        return () => window.removeEventListener('scn-open-history' as any, handleOpenHistory);
    }, [setHistoryOpen]);

    return (
        <div className="min-h-screen flex flex-col pt-14" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
            <main className="flex-1 relative w-full overflow-hidden" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
                <AnimatePresence mode="wait">
                    {step === 'upload' && (
                        <motion.div key="upload" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} 
                            className="absolute inset-0 p-4 sm:p-6 flex flex-col items-center justify-center custom-scrollbar overflow-y-auto overflow-x-hidden">
                            <div className="w-full max-w-2xl vertical-offset-active">
                                <UploadZone />
                            </div>
                        </motion.div>
                    )}
                    {/* Transcripción y organización comparten pantalla: son dos
                        etapas del mismo proceso y separarlas obligaba a reiniciar
                        la barra a mitad de camino. */}
                    {(step === 'transcribing' || step === 'ai-processing') && (
                        <motion.div key="processing" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}
                            className="absolute inset-0 p-4 sm:p-6 flex flex-col items-center justify-center custom-scrollbar overflow-y-auto overflow-x-hidden">
                            <div className="w-full max-w-xl vertical-offset-active">
                                <ProcessingView />
                            </div>
                        </motion.div>
                    )}
                    {step === 'editor' && (
                        <motion.div key="editor" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} 
                            className="absolute inset-0 p-4 sm:p-6 flex flex-col items-center justify-start custom-scrollbar overflow-y-auto overflow-x-hidden vertical-offset-none">
                            <div className="w-full max-w-6xl h-full min-h-[calc(100vh-7rem)] flex flex-col">
                                <NotesEditor />
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </main>

            {/* Error toast */}
            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 20 }}
                        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-lg text-sm max-w-md"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5' }}
                    >
                        <span className="flex-1">{error}</span>
                        <button onClick={() => setError(null)} className="p-0.5" style={{ color: 'var(--text-muted)' }}>
                            <X size={14} />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Config modal */}
            <AnimatePresence>
                {configOpen && <ConfigModal />}
            </AnimatePresence>

            {/* Historial de archivos y apuntes */}
            <AnimatePresence>
                {historyOpen && <HistoryPanel />}
            </AnimatePresence>
        </div>
    );
}

import { useEffect, useRef } from 'react';
import { useAppStore } from '../../lib/store';
import { processAudioForUpload } from '../../lib/audio-processor';
import { t } from '../../lib/i18n';
import { resetModelHealth } from '../../lib/gemini';
import { splitTitle } from '../../lib/notes-prompt';
import { providerFor, resolveTranscriptionModel } from '../../lib/providers';
import { updateProjectState, db } from '../../lib/db';
import { progress, m as msg } from '../../lib/progress';
import { beginRun, isAborted, isCancelledError } from '../../lib/pipeline-control';

/**
 * Escritura de estado en IndexedDB que no puede tumbar el proceso.
 *
 * Estas llamadas son informativas (sirven para restaurar la sesión), pero iban
 * sin `catch`: en modo incógnito o con la cuota de disco llena, la promesa
 * rechazada se convertía en un `unhandledrejection` en mitad de una
 * transcripción de media hora.
 */
const persist = (id: number | null, patch: Parameters<typeof updateProjectState>[1]) => {
    if (id === null) return;
    updateProjectState(id, patch).catch((e) => console.warn('[Processor] No se pudo guardar el estado:', e));
};

const playNotificationSound = () => {
    try {
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();

        const playTone = (freq: number, startTime: number, duration: number) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, startTime);

            gain.gain.setValueAtTime(0, startTime);
            gain.gain.linearRampToValueAtTime(0.3, startTime + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

            osc.start(startTime);
            osc.stop(startTime + duration);
        };

        const now = ctx.currentTime;
        // Simple success chime: C5 -> E5
        playTone(523.25, now, 0.4);
        playTone(659.25, now + 0.15, 0.6);

        setTimeout(() => ctx.close(), 1000);
    } catch (e) {
        console.error("Audio notification err:", e);
    }
};

/**
 * Traduce la etapa que reporta el pipeline de audio a una frase concreta.
 * El `stage` ya lo emitía audio-processor/ffmpeg-chunker; hasta ahora se
 * descartaba con `(_stage, p)` y el usuario sólo veía "Optimizando audio".
 */
const prepareDetail = (stage: string, isVideo: boolean): string => {
    switch (stage) {
        case 'loading':
            return msg('Cargando el motor de audio (FFmpeg)', 'Loading the audio engine (FFmpeg)');
        case 'preparing':
            return msg('Leyendo el archivo', 'Reading the file');
        case 'chunking':
            return msg('Dividiendo el audio en fragmentos', 'Splitting the audio into chunks');
        case 'compressing':
            return isVideo
                ? msg('Extrayendo la pista de audio', 'Extracting the audio track')
                : msg('Comprimiendo el audio para subirlo más rápido', 'Compressing the audio for a faster upload');
        default:
            return msg('Preparando el audio', 'Preparing the audio');
    }
};

export default function GlobalAudioProcessor() {
    const {
        file, apiKey, geminiKey, provider, locale,
        processingState, setProcessingState,
        setProcessingProgress, setCompressionInfo,
        setTranscription, setStep, setError,
        setOrganizedNotes, setAiStep, setTitle,
        currentProjectId, restoreSession,
        activeKey, summaryLevel, outputLanguage,
        transcriptionModel
    } = useAppStore();

    // Restaurar sesión al montar
    useEffect(() => {
        restoreSession();
    }, []);

    const processingRef = useRef(false);

    // Efecto principal de procesamiento
    useEffect(() => {
        if (!file || processingState !== 'compressing') {
            if (processingState === 'idle') {
                processingRef.current = false;
            }
            return;
        }

        if (processingRef.current) return;
        processingRef.current = true;

        const run = async () => {
            // La señal vive en pipeline-control: es la misma que consultan las
            // capas de red, así que cancelar corta también las peticiones y los
            // backoff en curso, no sólo el bucle de este componente.
            beginRun();
            resetModelHealth();
            const isCancelled = () => isAborted();

            // Obtener API key desencriptada
            const key = activeKey();

            if (!key) {
                setError(locale === 'es' ? 'Falta API Key' : 'API Key missing');
                setProcessingState('error');
                setStep('upload');
                processingRef.current = false;
                return;
            }

            try {
                await runFlow(key, isCancelled);
            } catch (err: any) {
                if (isCancelled() || isCancelledError(err)) {
                    console.log('[Processor] Process cancelled by user');
                    return;
                }
                console.error('[Processor] Error:', err);
                const message = err?.message || String(err);
                progress.fail(message);
                setError(message);
                setProcessingState('error');
                // Se queda en la pantalla de progreso a propósito: ahí están el
                // registro de actividad y el detalle por fragmento, que es lo
                // único que explica QUÉ falló. Mandar al usuario de vuelta a
                // subir un archivo borraba toda esa información.
                if (currentProjectId) {
                    db.projects.update(currentProjectId, { status: 'error' })
                        .catch(() => { /* informativo */ });
                }
            } finally {
                processingRef.current = false;
            }
        };

        run();
    }, [file, processingState, apiKey, geminiKey, provider]);

    /**
     * El camino, uno solo: preparar el audio, transcribir, redactar, guardar.
     *
     * Aquí había dos copias de esto —`runGeminiFlow` y `runGroqFlow`— de unas
     * doscientas líneas cada una y con el cuerpo idéntico salvo en las dos
     * llamadas que hacen el trabajo. Cada arreglo había que hacerlo dos veces, y
     * no se hacía: el título se extraía con reglas distintas en cada flujo, y el
     * de Groq seguía buscando un formato de encabezado que su prompt ya no
     * produce. Lo que cambia por proveedor vive ahora en `providers.ts`.
     */
    const runFlow = async (key: string, isCancelled: () => boolean) => {
        const flowStart = Date.now();
        const p = providerFor(provider);
        // El selector es único para los dos proveedores: aquí se descarta un id
        // que no sea de este proveedor en vez de mandárselo y comer un 404.
        const activeModel = resolveTranscriptionModel(provider, transcriptionModel);
        const isVideo = file!.type.startsWith('video/');

        console.log(`[${p.label} Flow] 🚀 Starting`);

        // PASO 1: preparar el audio (comprimir y/o trocear).
        //
        // Las etapas se anuncian con las de la ruta sin trocear y se replantean
        // en cuanto se sabe la duración: hasta después de preparar el audio no
        // se sabe si habrá fragmentos, y por tanto si hay etapa de subida.
        progress.start({
            provider,
            fileName: file!.name,
            fileSize: file!.size,
            stages: ['prepare', 'transcribe', 'organize'],
            locale,
        });
        progress.beginStage('prepare', prepareDetail('preparing', isVideo));
        setProcessingState('compressing');

        const processed = await processAudioForUpload(file!, (stage, prog) => {
            if (isCancelled()) return;
            progress.setStage('prepare', prog, prepareDetail(stage, isVideo));
            setProcessingProgress(prog);
            persist(currentProjectId, { step: 'upload', subStep: 'compressing', progress: prog });
        }, { provider, forceCompression: isVideo });

        if (isCancelled()) return;

        if (processed.wasCompressed) {
            const saved = Math.round((1 - processed.compressedSize / processed.originalSize) * 100);
            const sizeStr = (processed.compressedSize / (1024 * 1024)).toFixed(1);
            const label = isVideo ? t('notif.audio_extracted', locale) : t('notif.audio_optimized', locale);
            const chunkNote = processed.wasChunked
                ? ` · ${processed.chunks.length} ${t('notif.chunks', locale)}`
                : '';
            setCompressionInfo(`${label}: ${sizeStr}MB (-${saved}%)${chunkNote}`);
            progress.pushEvent('success', isVideo
                ? msg(`Audio extraído del vídeo (${saved}% menos de tamaño)`, `Audio extracted from video (${saved}% smaller)`)
                : msg(`Audio comprimido un ${saved}%`, `Audio compressed by ${saved}%`));
        }

        const durationMinutes = (processed.duration || 0) / 60;
        progress.setDuration(processed.duration || 0);
        progress.replan(p.stagesFor(processed));
        progress.finishStage('prepare');

        // PASO 2: transcribir.
        const transcriptionStart = Date.now();
        setProcessingState('uploading');
        setProcessingProgress(0);

        const stages = p.stagesFor(processed);
        const hasUploadStage = stages.includes('upload');
        progress.beginStage(
            hasUploadStage ? 'upload' : 'transcribe',
            hasUploadStage
                ? msg('Subiendo el audio', 'Uploading the audio')
                : msg('Transcribiendo el audio', 'Transcribing the audio'),
        );

        const transcription = await p.transcribe({
            processed,
            apiKey: key,
            model: activeModel,
            onProgress: (prog, phase) => {
                if (isCancelled()) return;
                if (phase === 'transcribe' && progress.getSnapshot().activeStage === 'upload') {
                    progress.finishStage('upload');
                    progress.beginStage('transcribe', msg('Transcribiendo el audio', 'Transcribing the audio'));
                }
                setProcessingState(phase === 'upload' ? 'uploading' : 'transcribing');
                setProcessingProgress(prog);
                persist(currentProjectId, {
                    step: phase === 'upload' ? 'upload' : 'transcribing',
                    subStep: phase === 'upload' ? 'uploading' : 'transcribing',
                    progress: prog,
                });
            },
        });

        if (isCancelled()) return;

        console.log(`[${p.label} Flow] ✅ Transcription (${((Date.now() - transcriptionStart) / 1000).toFixed(1)}s)`);

        progress.finishStage('upload');
        progress.finishStage('transcribe', msg('Transcripción completada', 'Transcription complete'));

        const text = transcription.text;
        if (!text || text.trim().length === 0) {
            throw new Error(locale === 'es' ? 'La transcripción está vacía.' : 'Transcription is empty.');
        }

        setTranscription(text);
        persist(currentProjectId, { transcription: text });

        // PASO 3: redactar los apuntes.
        const organizeStart = Date.now();
        setProcessingState('analyzing');
        setStep('ai-processing');
        setAiStep(0);
        progress.beginStage('organize', msg('Estructurando los apuntes', 'Structuring the notes'));
        progress.pushEvent('info', msg(
            `Transcripción lista: ${text.length.toLocaleString()} caracteres`,
            `Transcript ready: ${text.length.toLocaleString()} characters`,
        ));

        const organized = await p.organize({
            transcription: text,
            apiKey: key,
            summaryLevel,
            outputLanguage,
            onStep: (s) => {
                if (isCancelled()) return;
                setAiStep(s);
                progress.setStage('organize', Math.min(0.95, s / 5));
                persist(currentProjectId, { step: 'ai-processing', progress: s / 5 });
            },
        });

        if (isCancelled()) return;

        console.log(`[${p.label} Flow] ✅ Organization (${((Date.now() - organizeStart) / 1000).toFixed(1)}s)`);

        // PASO 4: título, guardado y aviso.
        const { title: resolvedTitle, body: cleanNotes } = splitTitle(organized.notes);
        if (resolvedTitle) setTitle(resolvedTitle);

        setOrganizedNotes(cleanNotes);
        setProcessingState('done');
        progress.finishStage('organize');
        progress.finish();

        persist(currentProjectId, {
            step: 'editor',
            subStep: 'done',
            progress: 1,
            organizedNotes: cleanNotes,
            metadata: { provider, durationMinutes: durationMinutes.toFixed(1) },
        });
        if (currentProjectId) {
            // El título guardado es el mismo que ve el usuario: antes, si el
            // modelo omitía el `#` y se recurría al primer `##`, la pantalla
            // mostraba uno y la lista de proyectos guardaba 'Untitled Note'.
            db.projects.update(currentProjectId, {
                status: 'done',
                title: resolvedTitle || file?.name || 'Untitled Note',
            }).catch((e) => console.warn('[Processor] No se pudo guardar el título:', e));
        }

        playNotificationSound();
        setStep('editor');

        const totalTokens = transcription.tokensUsed + organized.tokensUsed;
        console.log(`[${p.label} Flow] ✅ COMPLETE — ${((Date.now() - flowStart) / 1000).toFixed(1)}s`
            + (totalTokens ? ` · ${totalTokens.toLocaleString()} tokens de salida` : ''));
    };

    return null; // Headless component
}
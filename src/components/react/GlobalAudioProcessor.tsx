import { useEffect, useRef } from 'react';
import { useAppStore } from '../../lib/store';
import { processAudioForUpload } from '../../lib/audio-processor';
import { transcribeAudio, organizeNotes } from '../../lib/groq';
import { t } from '../../lib/i18n';
import { transcribeWithGemini, organizeNotesWithGemini, transcribeWithGeminiChunked, DURATION_THRESHOLD_CHUNKING, resetModelHealth } from '../../lib/gemini';
import { updateProjectState, db } from '../../lib/db';
import { progress, m as msg } from '../../lib/progress';
import { beginRun, isAborted, isCancelledError } from '../../lib/pipeline-control';
import { resolveTranscriptionModel } from '../../lib/models';

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
                if (provider === 'gemini') {
                    await runGeminiFlow(key, isCancelled);
                } else {
                    await runGroqFlow(key, isCancelled);
                }
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

    const runGeminiFlow = async (key: string, isCancelled: () => boolean) => {
        const flowStartTime = Date.now();
        // El selector es único para los dos proveedores: aquí se descarta un id
        // que no pertenezca a Gemini en vez de mandárselo y comer un 404.
        const activeModel = resolveTranscriptionModel('gemini', transcriptionModel);

        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('[Gemini Flow] 🚀 Starting');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            const isVideo = file!.type.startsWith('video/');
            progress.start({
                provider: 'gemini',
                fileName: file!.name,
                fileSize: file!.size,
                stages: ['prepare', 'upload', 'transcribe', 'organize'],
                locale,
            });
            progress.beginStage('prepare', prepareDetail('preparing', isVideo));

            // PASO 1: Procesar audio
            const processingStart = Date.now();
            const processed = await processAudioForUpload(file!, (stage, p) => {
                if (!isCancelled()) {
                    progress.setStage('prepare', p, prepareDetail(stage, isVideo));
                    setProcessingProgress(p);
                    persist(currentProjectId, {
                        step: 'upload',
                        subStep: 'compressing',
                        progress: p
                    });
                }
            }, {
                provider: 'gemini',
                forceCompression: file!.type.startsWith('video/')
            });

            const processingTime = ((Date.now() - processingStart) / 1000).toFixed(1);
            console.log(`[Gemini Flow] ✅ Audio processed (${processingTime}s)`);

            if (isCancelled()) return;

            // Mostrar info de compresión si aplica
            if (processed.wasCompressed) {
                const saved = Math.round((1 - processed.compressedSize / processed.originalSize) * 100);
                const sizeStr = (processed.compressedSize / (1024 * 1024)).toFixed(1);
                const label = file!.type.startsWith('video/')
                    ? t('notif.audio_extracted', locale)
                    : t('notif.audio_optimized', locale);
                setCompressionInfo(`${label}: ${sizeStr}MB (-${saved}%)`);
            }

            const durationMinutes = (processed.duration || 0) / 60;
            console.log(`[Gemini Flow] Duration: ${durationMinutes.toFixed(1)} min`);

            progress.setDuration(processed.duration || 0);
            if (processed.wasCompressed) {
                const saved = Math.round((1 - processed.compressedSize / processed.originalSize) * 100);
                progress.pushEvent('success', isVideo
                    ? msg(`Audio extraído del vídeo (${saved}% menos de tamaño)`, `Audio extracted from video (${saved}% smaller)`)
                    : msg(`Audio comprimido un ${saved}%`, `Audio compressed by ${saved}%`));
            }
            progress.finishStage('prepare');

            // PASO 2: Transcribir (con o sin chunking)
            const transcriptionStart = Date.now();
            setProcessingState('uploading');
            setProcessingProgress(0);

            let transcriptionResult: { text: string; tokensUsed: number };

            // 🎯 DECISIÓN DE RUTA: >= 20 min usa chunking
            if (durationMinutes >= DURATION_THRESHOLD_CHUNKING) {
                console.log(`[Gemini Flow] Using CHUNKED strategy (>= ${DURATION_THRESHOLD_CHUNKING} min)`);

                // Ruta con fragmentos: cada uno se sube por su cuenta, así que
                // no hay una etapa de subida separada que mostrar.
                progress.replan(['prepare', 'transcribe', 'organize']);
                progress.beginStage('transcribe', msg('Preparando fragmentos', 'Preparing chunks'));

                transcriptionResult = await transcribeWithGeminiChunked(
                    processed.wasChunked ? processed.chunks : processed.chunks[0],
                    key,
                    (p) => {
                        if (isCancelled()) return;
                        setProcessingState('transcribing');
                        persist(currentProjectId, {
                            step: 'transcribing',
                            subStep: 'transcribing',
                            progress: p
                        });
                        setProcessingProgress(p);
                    },
                    processed.duration,
                    processed.chunkMetadata,
                    activeModel,
                );
            } else {
                console.log(`[Gemini Flow] Using STANDARD strategy (< ${DURATION_THRESHOLD_CHUNKING} min)`);

                progress.beginStage('upload', msg('Subiendo el audio a Gemini', 'Uploading the audio to Gemini'));

                transcriptionResult = await transcribeWithGemini(
                    processed.chunks[0],
                    key,
                    (p) => {
                        if (isCancelled()) return;

                        if (p >= 0.5 && progress.getSnapshot().activeStage === 'upload') {
                            // El 50% del callback marca el final de la subida:
                            // a partir de ahí el progreso lo dictan los
                            // timestamps que emite el propio modelo.
                            progress.finishStage('upload');
                            progress.beginStage('transcribe', msg('Transcribiendo el audio', 'Transcribing the audio'));
                        }

                        if (p < 0.5) {
                            setProcessingState('uploading');
                            persist(currentProjectId, {
                                step: 'upload',
                                subStep: 'uploading',
                                progress: p
                            });
                        } else {
                            setProcessingState('transcribing');
                            persist(currentProjectId, {
                                step: 'transcribing',
                                subStep: 'transcribing',
                                progress: p
                            });
                        }
                        setProcessingProgress(p);
                    },
                    processed.duration || 0,
                    0,
                    activeModel
                );
            }

            const transcriptionTime = ((Date.now() - transcriptionStart) / 1000).toFixed(1);
            console.log(`[Gemini Flow] ✅ Transcription (${transcriptionTime}s)`);

            if (isCancelled()) return;

            progress.finishStage('upload');
            progress.finishStage('transcribe', msg('Transcripción completada', 'Transcription complete'));

            const text = transcriptionResult.text;

            if (!text || text.trim().length === 0) {
                throw new Error(locale === 'es'
                    ? 'La transcripción está vacía.'
                    : 'Transcription is empty.');
            }

            setTranscription(text);
            persist(currentProjectId, { transcription: text });

            // PASO 3: Organizar notas
            const organizationStart = Date.now();
            setProcessingState('analyzing');
            setStep('ai-processing');
            setAiStep(0);
            progress.beginStage('organize', msg('Estructurando los apuntes', 'Structuring the notes'));
            progress.pushEvent('info', msg(
                `Transcripción lista: ${text.length.toLocaleString()} caracteres`,
                `Transcript ready: ${text.length.toLocaleString()} characters`,
            ));

            const organizationResult = await organizeNotesWithGemini(text, key, (s) => {
                if (!isCancelled()) {
                    setAiStep(s);
                    // Gemini organiza sin streaming: sin esto la barra se
                    // quedaba clavada durante todo el minuto largo que tarda.
                    progress.setStage('organize', Math.min(0.95, s / 5));
                    persist(currentProjectId, {
                        step: 'ai-processing',
                        progress: s / 5
                    });
                }
            }, summaryLevel, outputLanguage);

            const organizationTime = ((Date.now() - organizationStart) / 1000).toFixed(1);
            console.log(`[Gemini Flow] ✅ Organization (${organizationTime}s)`);

            if (isCancelled()) return;

            const notes = organizationResult.notes;

            // Extraer título — busca primero el # h1, si el modelo lo omitió usa el primer ## h2
            let cleanNotes = notes;
            let resolvedTitle = '';
            const titleMatch = notes.match(/^#\s+(.+)/m);
            if (titleMatch) {
                resolvedTitle = titleMatch[1].trim();
                cleanNotes = notes.replace(/^#\s+.+\n+/, '').trim();
            } else {
                // Fallback: el modelo saltó el # título — usar el primer ## encabezado
                const h2Match = notes.match(/^##\s+(.+)/m);
                if (h2Match) {
                    resolvedTitle = h2Match[1].trim().replace(/^\d+\.\s*/, ''); // quitar "1. " si existe
                    console.warn('[Gemini Flow] ⚠️  No # title found, using first ## as title:', resolvedTitle);
                }
                // cleanNotes queda igual — no hay nada que remover
            }
            if (resolvedTitle) setTitle(resolvedTitle);

            setOrganizedNotes(cleanNotes);
            setProcessingState('done');
            progress.finishStage('organize');
            progress.finish();

            // Actualizar DB
            persist(currentProjectId, {
                step: 'editor',
                subStep: 'done',
                progress: 1,
                organizedNotes: cleanNotes,
                metadata: {
                    processingMode: durationMinutes >= DURATION_THRESHOLD_CHUNKING ? 'chunked-transcription' : 'standard-transcription',
                    durationMinutes: durationMinutes.toFixed(1)
                }
            });
            if (currentProjectId) {
                // El título guardado es el mismo que ve el usuario: antes, si el
                // modelo omitía el `#` y se recurría al primer `##`, la pantalla
                // mostraba uno y la lista de proyectos guardaba 'Untitled Note'.
                db.projects.update(currentProjectId, {
                    status: 'done',
                    title: resolvedTitle || file?.name || 'Untitled Note'
                }).catch((e) => console.warn('[Processor] No se pudo guardar el título:', e));
            }

            playNotificationSound();
            setStep('editor');

            const totalTime = ((Date.now() - flowStartTime) / 1000).toFixed(1);
            const totalTokens = transcriptionResult.tokensUsed + organizationResult.tokensUsed;

            // LOG FINAL CON RESUMEN DE TOKENS
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('[Gemini Flow] ✅ COMPLETE');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`[Gemini Flow] Total time: ${totalTime}s`);
            console.log(`[Gemini Flow] Breakdown:`);
            console.log(`  • Processing: ${processingTime}s`);
            console.log(`  • Transcription: ${transcriptionTime}s`);
            console.log(`  • Organization: ${organizationTime}s`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`[Gemini Flow] 🎯 TOTAL OUTPUT TOKENS: ${totalTokens.toLocaleString()}`);
            console.log(`  • Transcription: ${transcriptionResult.tokensUsed.toLocaleString()}`);
            console.log(`  • Organization: ${organizationResult.tokensUsed.toLocaleString()}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        } catch (err: any) {
            throw err;
        }
    };

    const runGroqFlow = async (key: string, isCancelled: () => boolean) => {
        const activeModel = resolveTranscriptionModel('groq', transcriptionModel);
        try {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('[Groq Flow] 🚀 Starting');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            const isVideo = file!.type.startsWith('video/');
            progress.start({
                provider: 'groq',
                fileName: file!.name,
                fileSize: file!.size,
                stages: ['prepare', 'transcribe', 'organize'],
                locale,
            });
            progress.beginStage('prepare', prepareDetail('preparing', isVideo));

            // PASO 1: Procesar audio (comprimir y chunkear si es necesario)
            setProcessingState('compressing');
            const processed = await processAudioForUpload(file!, (stage, p) => {
                if (!isCancelled()) {
                    progress.setStage('prepare', p, prepareDetail(stage, isVideo));
                    setProcessingProgress(p);
                    persist(currentProjectId, {
                        step: 'upload',
                        subStep: 'compressing',
                        progress: p
                    });
                }
            }, {
                provider: 'groq',
                forceCompression: file!.type.startsWith('video/')
            });

            if (isCancelled()) return;

            // Mostrar info de compresión
            if (processed.wasCompressed) {
                const saved = Math.round((1 - processed.compressedSize / processed.originalSize) * 100);
                const sizeStr = (processed.compressedSize / (1024 * 1024)).toFixed(1);
                const label = file!.type.startsWith('video/')
                    ? t('notif.audio_extracted', locale)
                    : t('notif.audio_optimized', locale);
                const fragmentsLabel = t('notif.chunks', locale);

                setCompressionInfo(
                    `${label}: ${sizeStr}MB (-${saved}%)${processed.wasChunked ? ` · ${processed.chunks.length} ${fragmentsLabel}` : ''}`
                );
            }

            progress.setDuration(processed.duration || 0);
            if (processed.wasCompressed) {
                const saved = Math.round((1 - processed.compressedSize / processed.originalSize) * 100);
                progress.pushEvent('success', isVideo
                    ? msg(`Audio extraído del vídeo (${saved}% menos de tamaño)`, `Audio extracted from video (${saved}% smaller)`)
                    : msg(`Audio comprimido un ${saved}%`, `Audio compressed by ${saved}%`));
            }
            progress.finishStage('prepare');

            // Reparto temporal de los fragmentos: Whisper los procesa en serie,
            // así que el tablero necesita saber qué trozo de audio cubre cada uno.
            // Si no se pudo leer la duración, se reparte a partes iguales: el
            // tablero sigue siendo útil ("fragmento 2 de 5") aunque no haya
            // minutos que mostrar.
            const totalSec = processed.duration || processed.chunks.length * 60;
            const chunkSeconds: number[] = [];
            let ranges: { startSec: number; endSec: number }[];

            if (processed.chunkMetadata?.length === processed.chunks.length) {
                // Troceado temporal: los tiempos son exactos y no hay que
                // deducirlos del tamaño de cada fragmento.
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
                progress.pushEvent('info', msg(
                    `Audio dividido en ${processed.chunks.length} fragmentos de ~25 MB`,
                    `Audio split into ${processed.chunks.length} chunks of ~25 MB`,
                ));
            }

            // PASO 2: Transcribir con Groq (Whisper)
            setProcessingState('transcribing');
            progress.beginStage('transcribe', msg('Transcribiendo con Whisper', 'Transcribing with Whisper'));
            setProcessingProgress(0.05);
            persist(currentProjectId, {
                step: 'transcribing',
                subStep: 'initializing',
                progress: 0.05
            });

            const text = await transcribeAudio(processed.chunks, key, (p) => {
                if (!isCancelled()) {
                    setProcessingProgress(p);
                    persist(currentProjectId, {
                        step: 'transcribing',
                        progress: p
                    });
                }
            }, chunkSeconds, activeModel);

            if (isCancelled()) return;

            console.log('[Groq Flow] Transcription complete:', text.length, 'chars');

            if (!text || text.trim().length === 0) {
                throw new Error(locale === 'es'
                    ? 'La transcripción está vacía.'
                    : 'Transcription is empty.');
            }

            setTranscription(text);
            persist(currentProjectId, { transcription: text });

            progress.finishStage('transcribe', msg('Transcripción completada', 'Transcription complete'));

            // PASO 3: Organizar notas con Groq
            setProcessingState('analyzing');
            setStep('ai-processing');
            setAiStep(0);
            progress.beginStage('organize', msg('Estructurando los apuntes', 'Structuring the notes'));
            progress.pushEvent('info', msg(
                `Transcripción lista: ${text.length.toLocaleString()} caracteres`,
                `Transcript ready: ${text.length.toLocaleString()} characters`,
            ));

            const notes = await organizeNotes(text, key, (s) => {
                if (!isCancelled()) {
                    setAiStep(s);
                    persist(currentProjectId, {
                        step: 'ai-processing',
                        progress: s / 5
                    });
                }
            }, summaryLevel, outputLanguage);

            if (isCancelled()) return;

            // Extraer título — busca primero el formato Groq (## Título), luego # h1, luego ## h2 como fallback
            let cleanNotes = notes;
            let resolvedTitle = '';
            const titleMatch = notes.match(/^## Título\s*\n(.+)/m);
            if (titleMatch) {
                resolvedTitle = titleMatch[1].trim().replace(/\*\*/g, '');
                cleanNotes = notes.replace(/^## Título\s*\n.+\n*/m, '').trim();
            } else {
                // Fallback: buscar # h1 (por si Groq cambia formato) o primer ## h2
                const h1Match = notes.match(/^#\s+(.+)/m);
                if (h1Match) {
                    resolvedTitle = h1Match[1].trim();
                    cleanNotes = notes.replace(/^#\s+.+\n+/, '').trim();
                } else {
                    const h2Match = notes.match(/^##\s+(.+)/m);
                    if (h2Match) {
                        resolvedTitle = h2Match[1].trim().replace(/^\d+\.\s*/, '');
                        console.warn('[Groq Flow] ⚠️  No title heading found, using first ## as title:', resolvedTitle);
                    }
                }
            }
            if (resolvedTitle) setTitle(resolvedTitle);

            setOrganizedNotes(cleanNotes);
            setProcessingState('done');
            progress.finishStage('organize');
            progress.finish();

            // Actualizar DB
            persist(currentProjectId, {
                step: 'editor',
                subStep: 'done',
                progress: 1,
                organizedNotes: cleanNotes
            });
            if (currentProjectId) {
                db.projects.update(currentProjectId, {
                    status: 'done',
                    title: resolvedTitle || file?.name || 'Untitled Note'
                }).catch((e) => console.warn('[Processor] No se pudo guardar el título:', e));
            }

            playNotificationSound();
            setStep('editor');
            console.log('[Groq Flow] ✅ Complete');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        } catch (err: any) {
            console.error('[Groq Flow] Error:', err);
            throw err;
        }
    };

    return null; // Headless component
}
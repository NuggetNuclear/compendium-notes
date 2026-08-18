import React, { useCallback, useState, useRef, useEffect } from 'react';
import { useAppStore } from '../../lib/store';
import { resolveTranscriptionModel, transcriptionModelsFor } from '../../lib/providers';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, FileAudio, FileVideo, Mic, Loader2, AlertCircle, CheckCircle, Clock, Volume2, ArrowRight, Sparkles, Zap, BrainCircuit, Info, RefreshCw, ChevronDown } from 'lucide-react';
import { t } from '../../lib/i18n';

import AudioRecorder from './AudioRecorder';
import SearchableLanguageSelect from './SearchableLanguageSelect';

// FORMATOS SOPORTADOS - Cobertura completa móvil + PC + grabadoras
const ACCEPTED = [
    // Audio estándar (universal)
    'audio/mpeg', 'audio/mp3',                    // MP3
    'audio/mp4', 'audio/x-m4a', 'audio/m4a',      // M4A (iPhone, Android, Zoom)
    'audio/aac', 'audio/x-aac',                   // AAC
    'audio/wav', 'audio/x-wav',                   // WAV

    // Audio móvil/web
    'audio/ogg',                                  // OGG (Android, Telegram)
    'audio/opus',                                 // Opus (WhatsApp, Discord)
    'audio/webm',                                 // WebM (Chrome recording)

    // Audio alta calidad
    'audio/flac', 'audio/x-flac',                 // FLAC (grabadoras profesionales)
    'audio/aiff', 'audio/x-aiff',                 // AIFF (Mac/Logic Pro)
    'audio/wma',                                  // WMA (Windows)

    // Video (extracción de audio)
    'video/mp4',                                  // MP4 universal
    'video/quicktime',                            // MOV (iPhone)
    'video/webm',                                 // WebM (Chrome recording)
    'video/x-matroska',                           // MKV
    'video/avi',                                  // AVI
    'video/x-msvideo',                            // AVI alternativo
];

const MAX_SIZE_GROQ = 150 * 1024 * 1024; // 150MB para Groq (que luego comprime)
const MAX_SIZE_GEMINI = 500 * 1024 * 1024; // 500MB para Gemini

export default function UploadZone() {
    const { setFile, startProcessing, setError, apiKey, geminiKey, provider, setConfigOpen, locale, file, processingState, summaryLevel, setSummaryLevel, transcriptionModel, setTranscriptionModel } = useAppStore();
    const [isDragging, setIsDragging] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [showHint, setShowHint] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // Dynamic Max Size based on Provider
    const currentMaxSize = provider === 'gemini' ? MAX_SIZE_GEMINI : MAX_SIZE_GROQ;
    const currentMaxSizeLabel = provider === 'gemini' ? '500MB' : '150MB';

    // Show hint if processing is active but stuck in this view
    useEffect(() => {
        let timer: NodeJS.Timeout;
        if (file && processingState !== 'idle') {
            timer = setTimeout(() => setShowHint(true), 3000);
        } else {
            setShowHint(false);
        }
        return () => clearTimeout(timer);
    }, [file, processingState]);

    const validate = useCallback((f: File): boolean => {
        // Un archivo vacío pasaba el filtro y moría mucho más tarde, con un
        // mensaje del proveedor que no decía nada útil.
        if (f.size === 0) {
            setError(locale === 'es'
                ? 'El archivo está vacío. Comprueba que la grabación se guardó bien.'
                : 'The file is empty. Check that the recording was saved correctly.');
            return false;
        }

        const isSupportedType = f.type && ACCEPTED.includes(f.type);

        // Extensiones soportadas (cobertura completa)
        const supportedExtensions = [
            // Audio
            'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'webm', 'flac', 'aiff', 'wma',
            // Video
            'mp4', 'mov', 'mkv', 'avi', 'webm'
        ];
        const isSupportedExtension = supportedExtensions.some(ext =>
            f.name.toLowerCase().endsWith(`.${ext}`)
        );

        if (!isSupportedType && !isSupportedExtension) {
            setError(locale === 'es'
                ? 'Formato no soportado. Usa MP3, M4A, WAV, OGG, OPUS, FLAC, MP4, MOV, MKV o WebM.'
                : 'Unsupported format. Use MP3, M4A, WAV, OGG, OPUS, FLAC, MP4, MOV, MKV or WebM.');
            return false;
        }

        // Validación estricta de tamaño según proveedor
        if (f.size > currentMaxSize) {
            setError(locale === 'es'
                ? `El archivo supera el límite de ${currentMaxSizeLabel} para ${provider === 'gemini' ? 'Gemini' : 'Groq'}.`
                : `File exceeds the ${currentMaxSizeLabel} limit for ${provider === 'gemini' ? 'Gemini' : 'Groq'}.`);
            return false;
        }
        return true;
    }, [setError, locale, currentMaxSize, currentMaxSizeLabel, provider]);

    const handleFile = useCallback((f: File) => {
        if (validate(f)) setFile(f);
    }, [validate, setFile]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
    }, [handleFile]);

    const handleStart = () => {
        const activeKey = provider === 'gemini' ? geminiKey : apiKey;
        if (!activeKey) {
            setConfigOpen(true);
            setError(t('app.error.apikey', locale));
            return;
        }
        if (file) startProcessing(file);
    };

    const handleRecordingComplete = (f: File) => {
        setIsRecording(false);
        handleFile(f);
    };

    const formatSize = (b: number) => b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;

    if (isRecording) {
        return (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
                <AudioRecorder
                    onRecordingComplete={handleRecordingComplete}
                    onCancel={() => setIsRecording(false)}
                />
            </div>
        );
    }

    return (
        <div className="space-y-8">
            <div className="text-center mb-2">
                <h1 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                    {t('app.upload.title', locale)}
                </h1>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    {t('app.upload.subtitle', locale)}
                </p>
            </div>

            {/* Drop zone */}
            <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => !file && inputRef.current?.click()}
                className="relative rounded-xl p-8 sm:p-10 text-center cursor-pointer transition-all duration-200 group"
                style={{
                    background: isDragging ? 'var(--accent-subtle)' : 'var(--bg-secondary)',
                    border: `1px ${isDragging ? 'solid' : 'dashed'} ${isDragging ? 'var(--accent)' : 'var(--border-default)'}`,
                }}
            >
                <input
                    ref={inputRef}
                    id="file-upload"
                    name="file-upload"
                    type="file"
                    accept="audio/*,video/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.webm,.flac,.aiff,.wma,.mp4,.mov,.mkv,.avi"
                    className="hidden"
                    onChange={(e) => {
                        if (e.target.files?.[0]) {
                            handleFile(e.target.files[0]);
                            // Reset value to allow re-selecting same file if needed later
                            e.target.value = '';
                        }
                    }}
                />

                {!file ? (
                    <div className="space-y-6">
                        <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center mb-4 transition-colors group-hover:bg-[var(--bg-tertiary)]" style={{ background: 'var(--accent-subtle)' }}>
                            <Upload size={20} style={{ color: 'var(--accent)' }} />
                        </div>
                        <div>
                            <p className="text-base font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                                {isDragging ? t('app.upload.dropping', locale) : t('app.upload.drop', locale)}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {locale === 'es'
                                    ? `Soporta MP3, M4A, WAV, OGG, OPUS, FLAC, MP4, MOV • Hasta ${currentMaxSizeLabel}`
                                    : `Supports MP3, M4A, WAV, OGG, OPUS, FLAC, MP4, MOV • Up to ${currentMaxSizeLabel}`
                                }
                            </p>
                        </div>
                        <div className="flex items-center justify-center gap-3">
                            <button
                                onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
                                className="btn-filled text-xs px-5 py-2.5 rounded-lg"
                            >
                                {t('app.upload.select', locale)}
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); setIsRecording(true); }}
                                className="btn-ghost text-xs px-5 py-2.5 rounded-lg flex items-center gap-2"
                            >
                                <Mic size={14} />
                                {t('app.record.start', locale)}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center gap-4 text-left" onClick={(e) => e.stopPropagation()}>
                        <div className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--accent-subtle)' }}>
                            <FileAudio size={18} style={{ color: 'var(--accent)' }} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{file.name}</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatSize(file.size)}</p>
                        </div>
                        {processingState === 'idle' && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setFile(null);
                                    if (inputRef.current) inputRef.current.value = '';
                                }}
                                className="text-xs px-2 py-1 rounded-sm transition-colors"
                                style={{ color: 'var(--text-muted)' }}
                                title={t('app.upload.remove', locale) || 'Remove file'}
                            >
                                ✕
                            </button>
                        )}
                    </div>
                )}
                {/* Hint for blocked state */}
                {showHint && processingState !== 'idle' && (
                    <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="mt-4">
                        <div className="flex flex-col items-center gap-2">
                            <p className="text-[10px] text-center opacity-60" style={{ color: 'var(--text-muted)' }}>
                                {t('app.processing.reset_desc', locale as any)}
                            </p>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    useAppStore.getState().reset();
                                }}
                                className="group flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider py-2 px-4 rounded-full transition-all border border-[var(--accent)]/30 hover:border-[var(--accent)] hover:bg-[var(--accent)]/10 text-[var(--accent)]"
                            >
                                <RefreshCw size={12} className="group-hover:rotate-180 transition-transform duration-700" />
                                {t('app.processing.stuck_btn', locale as any)}
                            </button>
                        </div>
                    </motion.div>
                )}

            </div>

            {/* Output Language Selector */}
            {file && processingState === 'idle' && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4"
                >
                    <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
                        {t('app.lang.output', locale)}
                    </label>
                    <SearchableLanguageSelect />
                </motion.div>
            )}

            {/* Summary Level Selector */}
            {file && processingState === 'idle' && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4"
                >
                    <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
                        {t('app.summary.level', locale)}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {(['short', 'medium', 'long'] as const).map((level) => (
                            <button
                                key={level}
                                onClick={() => setSummaryLevel(level)}
                                className="py-2.5 px-3 rounded-lg text-xs font-medium transition-all text-left"
                                style={{
                                    background: summaryLevel === level ? 'var(--accent-subtle)' : 'var(--bg-primary)',
                                    border: `1px solid ${summaryLevel === level ? 'var(--accent)' : 'var(--border-default)'}`,
                                    color: summaryLevel === level ? 'var(--accent)' : 'var(--text-muted)',
                                }}
                            >
                                <span className="block font-semibold">{t(`app.summary.${level}` as any, locale)}</span>
                                <span className="block text-[10px] opacity-70 mt-0.5">{t(`app.summary.${level}.desc` as any, locale)}</span>
                            </button>
                        ))}
                    </div>
                </motion.div>
            )}

            {/* Transcription Model Selector */}
            {file && processingState === 'idle' && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4"
                >
                    <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
                        {t('app.config.transcription_model', locale)}
                    </label>
                    <div className="relative">
                        <select
                            id="upload-transcription-model-select"
                            value={resolveTranscriptionModel(provider, transcriptionModel)}
                            disabled={processingState !== 'idle'}
                            onChange={(e) => setTranscriptionModel(e.target.value)}
                            className="w-full py-2.5 px-3 pr-8 rounded-lg text-xs font-medium transition-all appearance-none cursor-pointer outline-hidden focus:ring-2 focus:ring-[var(--accent)]"
                            style={{
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--border-default)',
                                color: 'var(--text-primary)',
                            }}
                        >
                            {transcriptionModelsFor(provider).map((m) => (
                                <option key={m.id} value={m.id} style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                                    {m.label} ({m.desc})
                                </option>
                            ))}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3" style={{ color: 'var(--text-muted)' }}>
                            <ChevronDown size={14} />
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Start button */}
            {file && processingState === 'idle' && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4"
                >
                    <button
                        onClick={handleStart}
                        className="w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium text-white transition-colors"
                        style={{ background: 'var(--accent)' }}
                    >
                        {t('app.upload.transcribe', locale)}
                        <ArrowRight size={15} />
                    </button>
                </motion.div>
            )}

            {/* Best Practices Guide */}
            {!file && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-8">
                    <div className="p-4 rounded-xl border transition-colors hover:bg-[var(--bg-secondary)]" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex items-center gap-2 mb-2" style={{ color: '#34d399' }}>
                            <Zap size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wider">Whisper + GPT-OSS</span>
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {locale === 'es'
                                ? 'Ideal para clases estándar (< 1h). Muy rápido y preciso con timestamps exactos. Usa Whisper V3 Turbo + GPT-OSS 120B.'
                                : 'Ideal for standard lectures (< 1h). Very fast and precise with exact timestamps. Uses Whisper V3 Turbo + GPT-OSS 120B.'}
                        </p>
                    </div>

                    <div className="p-4 rounded-xl border transition-colors hover:bg-[var(--bg-secondary)]" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex items-center gap-2 mb-2" style={{ color: '#60a5fa' }}>
                            <BrainCircuit size={16} />
                            <span className="text-xs font-semibold uppercase tracking-wider">Gemini 3.1 Flash Lite + 3 Flash</span>
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {locale === 'es'
                                ? 'Perfecto para audios muy largos (> 1h), cualquier formato (M4A, OPUS, FLAC, MKV, etc.) y contenido complejo.'
                                : 'Perfect for very long audios (> 1h), any format (M4A, OPUS, FLAC, MKV, etc.) and complex content.'}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
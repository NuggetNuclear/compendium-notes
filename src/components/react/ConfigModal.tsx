import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Eye, EyeOff, Clipboard, ExternalLink, Check, BadgeCheck, Loader2, Trash2, ChevronDown } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import { resolveTranscriptionModel, transcriptionModelsFor, providerFor } from '../../lib/providers';
import { t } from '../../lib/i18n';
import SearchableLanguageSelect from './SearchableLanguageSelect';

export default function ConfigModal() {
    const {
        apiKey, setApiKey, geminiKey, setGeminiKey,
        provider, setProvider, setConfigOpen,
        pdfStyle, setPdfStyle, locale, processingState,
        summaryLevel, setSummaryLevel,
        outputLanguage, setOutputLanguage,
        transcriptionModel, setTranscriptionModel
    } = useAppStore();

    const isProcessing = processingState !== 'idle' && processingState !== 'done' && processingState !== 'error';

    const [groqInput, setGroqInput] = useState('');
    const [geminiInput, setGeminiInput] = useState('');
    const [showGroq, setShowGroq] = useState(false);
    const [showGemini, setShowGemini] = useState(false);
    const [saved, setSaved] = useState(false);
    const [validating, setValidating] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSave = async () => {
        setErrorMsg(null);
        setValidating(true);

        try {
            if (groqInput) {
                const isValid = await providerFor('groq').validateKey(groqInput.trim());
                if (!isValid) {
                    setErrorMsg(t('app.config.error.groq', locale));
                    setValidating(false);
                    return;
                }
                setApiKey(groqInput.trim());
                setGroqInput('');
            }

            if (geminiInput) {
                const isValid = await providerFor('gemini').validateKey(geminiInput.trim());
                if (!isValid) {
                    setErrorMsg(t('app.config.error.gemini', locale));
                    setValidating(false);
                    return;
                }
                setGeminiKey(geminiInput.trim());
                setGeminiInput('');
            }

            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (e) {
            setErrorMsg(t('app.config.error.network', locale));
        } finally {
            setValidating(false);
        }
    };

    const handlePaste = async (target: 'groq' | 'gemini') => {
        try {
            const text = await navigator.clipboard.readText();
            if (target === 'groq') setGroqInput(text.trim());
            else setGeminiInput(text.trim());
        } catch { }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
            onClick={() => setConfigOpen(false)}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ duration: 0.2 }}
                className="w-full max-w-md rounded-xl overflow-hidden max-h-[90vh] overflow-y-auto custom-scrollbar"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 sticky top-0 z-10" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('app.config.title', locale)}
                    </h2>
                    <button onClick={() => setConfigOpen(false)} className="p-1 rounded-md transition-colors" style={{ color: 'var(--text-muted)' }}>
                        <X size={16} />
                    </button>
                </div>

                <div className="p-5 space-y-5">
                    {/* Provider Toggle */}
                    <div>
                        <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
                            {t('app.config.provider', locale)}
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                onClick={() => !isProcessing && setProvider('groq')}
                                disabled={isProcessing}
                                className={`py-2.5 px-3 rounded-lg text-xs font-medium transition-all ${isProcessing ? 'cursor-not-allowed' : ''}`}
                                style={{
                                    background: provider === 'groq' ? 'var(--accent-subtle)' : 'var(--bg-primary)',
                                    border: `1px solid ${provider === 'groq' ? 'var(--accent)' : 'var(--border-default)'}`,
                                    color: provider === 'groq' ? 'var(--accent)' : 'var(--text-muted)',
                                }}
                            >
                                <span className="block font-semibold mb-0.5">Groq</span>
                                <span className="block text-[10px] opacity-70">Whisper + GPT-OSS</span>
                            </button>
                            <button
                                onClick={() => !isProcessing && setProvider('gemini')}
                                disabled={isProcessing}
                                className={`py-2.5 px-3 rounded-lg text-xs font-medium transition-all ${isProcessing ? 'cursor-not-allowed' : ''}`}
                                style={{
                                    background: provider === 'gemini' ? 'var(--accent-subtle)' : 'var(--bg-primary)',
                                    border: `1px solid ${provider === 'gemini' ? 'var(--accent)' : 'var(--border-default)'}`,
                                    color: provider === 'gemini' ? 'var(--accent)' : 'var(--text-muted)',
                                }}
                            >
                                <span className="block font-semibold mb-0.5">Gemini</span>
                                <span className="block text-[10px] opacity-70">3.5 Flash Lite + fallbacks</span>
                            </button>
                        </div>
                    </div>

                    {/* Groq API Key */}
                    {provider === 'groq' && (
                        <div>
                            <label className="text-xs font-medium mb-2 flex items-center justify-between" style={{ color: 'var(--text-secondary)' }}>
                                <span className="flex items-center gap-1.5">
                                    Groq API Key
                                    {apiKey && !groqInput && (
                                        <span className="flex items-center gap-1 text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded-sm border border-emerald-500/20 font-semibold">
                                            <BadgeCheck size={10} />
                                            {t('app.config.active_encrypted', locale)}
                                        </span>
                                    )}
                                </span>
                                {groqInput.length > 5 && (
                                    <span className={`text-[10px] ${groqInput.startsWith('gsk_') ? 'text-green-500' : 'text-red-500'}`}>
                                        {groqInput.startsWith('gsk_') ? t('app.config.valid_format', locale) : t('app.config.invalid_format_groq', locale)}
                                    </span>
                                )}
                                {groqInput.length <= 5 && (
                                    <span className="text-[10px] text-[var(--text-muted)] opacity-70">
                                        {t('app.config.format_label', locale)} gsk_...
                                    </span>
                                )}
                            </label>
                            <div className="flex gap-2">
                                <div
                                    className={`flex-1 flex items-center rounded-lg px-3 transition-all duration-200 focus-within:ring-2 focus-within:ring-[var(--accent)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--bg-secondary)] ${groqInput.length > 0 && !groqInput.startsWith('gsk_') ? 'border-red-500/50 bg-red-500/5' : ''}`}
                                    style={{
                                        background: 'var(--bg-primary)',
                                        border: groqInput.length > 0 && !groqInput.startsWith('gsk_') ? '1px solid rgba(239,68,68,0.5)' : '1px solid var(--border-default)'
                                    }}
                                >
                                    <input
                                        ref={inputRef}
                                        id="groq-api-key"
                                        name="groq-api-key"
                                        type={showGroq ? 'text' : 'password'}
                                        value={groqInput}
                                        onChange={(e) => setGroqInput(e.target.value)}
                                        placeholder={apiKey ? t('app.config.new_key', locale) : 'gsk_...'}
                                        className="flex-1 bg-transparent border-none outline-hidden focus:outline-hidden focus:ring-0 text-sm py-2.5 font-mono"
                                        style={{ color: 'var(--text-primary)' }}
                                    />
                                    <button onClick={() => setShowGroq(!showGroq)} className="p-1 ml-1" style={{ color: 'var(--text-muted)' }}>
                                        {showGroq ? <EyeOff size={14} /> : <Eye size={14} />}
                                    </button>
                                </div>
                                <button onClick={() => handlePaste('groq')} className="px-3 rounded-lg text-xs transition-colors" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }} title={t('app.config.paste', locale)}>
                                    <Clipboard size={14} />
                                </button>
                                {apiKey && (
                                    <button
                                        onClick={() => !isProcessing && setApiKey('')}
                                        disabled={isProcessing}
                                        className={`px-3 rounded-lg text-xs transition-colors ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'hover:bg-red-500/10 hover:text-red-500'}`}
                                        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                                        title={t('app.config.clear', locale)}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                )}
                            </div>
                            <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs mt-2 no-underline transition-colors" style={{ color: 'var(--accent)' }}>
                                {t('app.config.groq.get', locale)}
                                <ExternalLink size={11} />
                            </a>
                        </div>
                    )}

                    {/* Gemini API Key */}
                    {provider === 'gemini' && (
                        <div>
                            <label className="text-xs font-medium mb-2 flex items-center justify-between" style={{ color: 'var(--text-secondary)' }}>
                                <span className="flex items-center gap-1.5">
                                    Gemini API Key
                                    {geminiKey && !geminiInput && (
                                        <span className="flex items-center gap-1 text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded-sm border border-emerald-500/20 font-semibold">
                                            <BadgeCheck size={10} />
                                            {t('app.config.active_encrypted', locale)}
                                        </span>
                                    )}
                                </span>
                                {geminiInput.length > 5 && (
                                    <span className={`text-[10px] ${geminiInput.startsWith('AQ') ? 'text-green-500' : 'text-red-500'}`}>
                                        {geminiInput.startsWith('AQ') ? t('app.config.valid_format', locale) : t('app.config.invalid_format_gemini', locale)}
                                    </span>
                                )}
                                {geminiInput.length <= 5 && (
                                    <span className="text-[10px] text-[var(--text-muted)] opacity-70">
                                        {t('app.config.format_label', locale)} AQ...
                                    </span>
                                )}
                            </label>
                            <div className="flex gap-2">
                                <div
                                    className={`flex-1 flex items-center rounded-lg px-3 transition-all duration-200 focus-within:ring-2 focus-within:ring-[var(--accent)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--bg-secondary)] ${geminiInput.length > 0 && !geminiInput.startsWith('AQ') ? 'border-red-500/50 bg-red-500/5' : ''}`}
                                    style={{
                                        background: 'var(--bg-primary)',
                                        border: geminiInput.length > 0 && !geminiInput.startsWith('AQ') ? '1px solid rgba(239,68,68,0.5)' : '1px solid var(--border-default)'
                                    }}
                                >
                                    <input
                                        id="gemini-api-key"
                                        name="gemini-api-key"
                                        type={showGemini ? 'text' : 'password'}
                                        value={geminiInput}
                                        onChange={(e) => setGeminiInput(e.target.value)}
                                        placeholder={geminiKey ? t('app.config.new_key', locale) : 'AQ...'}
                                        className="flex-1 bg-transparent border-none outline-hidden focus:outline-hidden focus:ring-0 text-sm py-2.5 font-mono"
                                        style={{ color: 'var(--text-primary)' }}
                                    />
                                    <button onClick={() => setShowGemini(!showGemini)} className="p-1 ml-1" style={{ color: 'var(--text-muted)' }}>
                                        {showGemini ? <EyeOff size={14} /> : <Eye size={14} />}
                                    </button>
                                </div>
                                <button onClick={() => handlePaste('gemini')} className="px-3 rounded-lg text-xs transition-colors" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }} title={t('app.config.paste', locale)}>
                                    <Clipboard size={14} />
                                </button>
                                {geminiKey && (
                                    <button
                                        onClick={() => !isProcessing && setGeminiKey('')}
                                        disabled={isProcessing}
                                        className={`px-3 rounded-lg text-xs transition-colors ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'hover:bg-red-500/10 hover:text-red-500'}`}
                                        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                                        title={t('app.config.clear', locale)}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                )}
                            </div>
                            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs mt-2 no-underline transition-colors" style={{ color: 'var(--accent)' }}>
                                {t('app.config.gemini.get', locale)}
                                <ExternalLink size={11} />
                            </a>
                        </div>
                    )}

                    {/* Privacy note */}
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        {t('app.config.privacy', locale)}
                    </p>

                    {/* PDF Style Selector */}
                    <div>
                        <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
                            {t('app.config.pdfstyle', locale)}
                        </label>
                        <div className="grid grid-cols-3 gap-2">
                            {(['minimalista', 'academico', 'cornell'] as const).map((style) => (
                                <button
                                    key={style}
                                    onClick={() => setPdfStyle(style)}
                                    className="py-2 px-3 rounded-lg text-xs font-medium transition-all capitalize"
                                    style={{
                                        background: pdfStyle === style ? 'var(--accent-subtle)' : 'var(--bg-primary)',
                                        border: `1px solid ${pdfStyle === style ? 'var(--accent)' : 'var(--border-default)'}`,
                                        color: pdfStyle === style ? 'var(--accent)' : 'var(--text-muted)',
                                    }}
                                >
                                    {t(`app.style.${style}` as any, locale)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Output Language Selector */}
                    <div>
                        <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
                            {t('app.lang.output', locale)}
                        </label>
                        <div className="w-full">
                            <SearchableLanguageSelect disabled={isProcessing} />
                        </div>
                    </div>

                    {/* Transcription Model Selector */}
                    <div>
                        <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
                            {t('app.config.transcription_model', locale)}
                        </label>
                        <p className="text-[11px] mb-2 leading-tight" style={{ color: 'var(--text-muted)' }}>
                            {t('app.config.transcription_model.desc', locale)}
                        </p>
                        <div className="relative">
                            <select
                                id="transcription-model-select"
                                value={resolveTranscriptionModel(provider, transcriptionModel)}
                                disabled={isProcessing}
                                onChange={(e) => setTranscriptionModel(e.target.value)}
                                className={`w-full py-2.5 px-3 pr-8 rounded-lg text-xs font-medium transition-all appearance-none cursor-pointer outline-hidden focus:ring-2 focus:ring-[var(--accent)] ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                                style={{
                                    background: 'var(--bg-primary)',
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
                    </div>

                    {/* Summary Level Selector */}
                    <div>
                        <label className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-secondary)' }}>
                            {t('app.summary.level', locale)}
                        </label>
                        <div className="grid grid-cols-3 gap-2">
                            {(['short', 'medium', 'long'] as const).map((level) => (
                                <button
                                    key={level}
                                    disabled={isProcessing}
                                    onClick={() => setSummaryLevel(level)}
                                    className={`py-2.5 px-3 rounded-lg text-xs font-medium transition-all text-left ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    style={{
                                        background: summaryLevel === level ? 'var(--accent-subtle)' : 'var(--bg-primary)',
                                        border: `1px solid ${summaryLevel === level && !isProcessing ? 'var(--accent)' : 'var(--border-default)'}`,
                                        color: summaryLevel === level ? 'var(--accent)' : 'var(--text-muted)',
                                    }}
                                >
                                    <span className="block font-semibold">{t(`app.summary.${level}` as any, locale)}</span>
                                    <span className="block text-[10px] opacity-70 mt-0.5">{t(`app.summary.${level}.desc` as any, locale)}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Error Message */}
                    {errorMsg && (
                        <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded-sm border border-red-500/20">
                            {errorMsg}
                        </div>
                    )}

                    {/* Save button */}
                    <button
                        onClick={handleSave}
                        disabled={validating || isProcessing}
                        className="w-full py-2.5 rounded-lg text-sm font-medium text-white transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
                        style={{ background: saved ? '#10b981' : 'var(--accent)' }}
                    >
                        {validating ? (
                            <><Loader2 size={14} className="animate-spin" /> {t('app.config.verifying', locale)}</>
                        ) : isProcessing ? (
                            <><Loader2 size={14} className="animate-spin" /> {t('app.config.processing', locale)}</>
                        ) : saved ? (
                            <><Check size={14} /> {t('app.config.saved', locale)}</>
                        ) : (
                            t('app.config.save', locale)
                        )}
                    </button>
                </div>
            </motion.div>
        </motion.div>
    );
}

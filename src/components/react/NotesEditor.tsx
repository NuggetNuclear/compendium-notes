import React, { useState, useMemo, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Copy, Check, Download, Loader2, RotateCcw, PenLine, Eye, FileText, ExternalLink, Palette, MessageSquareText, Sparkles, Play, Pause, Volume2, VolumeX, Type, Clock, Hash } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import type { SummaryLevel } from '../../lib/store';
import { t } from '../../lib/i18n';
import { generatePdf } from '../../lib/pdf-generator';
import { providerFor } from '../../lib/providers';
import { splitTitle } from '../../lib/notes-prompt';
import SearchableLanguageSelect from './SearchableLanguageSelect';

export default function NotesEditor() {
    const { editedNotes, setEditedNotes, file, reset, locale, transcription, pdfStyle, setPdfStyle, title, theme, provider, activeKey, setOrganizedNotes, setTitle, summaryLevel, setSummaryLevel, outputLanguage } = useAppStore();
    const [copied, setCopied] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [downloaded, setDownloaded] = useState(false);
    const [isStyleOpen, setIsStyleOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('preview');
    const [showTranscript, setShowTranscript] = useState(false);
    const [isResummarizing, setIsResummarizing] = useState(false);
    const [showResummarize, setShowResummarize] = useState(false);

    // Audio Player State
    const [audioPlaying, setAudioPlaying] = useState(false);
    const [audioTime, setAudioTime] = useState(0);
    const [audioDuration, setAudioDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const editorAudioRef = useRef<HTMLAudioElement | null>(null);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    // Create blob URL for file
    useEffect(() => {
        if (file) {
            const url = URL.createObjectURL(file);
            setAudioUrl(url);
            return () => {
                URL.revokeObjectURL(url);
                setAudioUrl(null);
            };
        }
    }, [file]);
    const stats = useMemo(() => {
        const text = editedNotes || '';
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        const readingTime = Math.max(1, Math.ceil(words / 200));
        const sections = (text.match(/^#{1,3}\s/gm) || []).length;
        return { words, readingTime, sections };
    }, [editedNotes]);

    // Smooth playback progress sync
    const progressFillRef = useRef<HTMLDivElement | null>(null);
    const timeDisplayRef = useRef<HTMLSpanElement | null>(null);

    const formatAudioTime = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    useEffect(() => {
        let frameId: number;
        const updateProgress = () => {
            if (editorAudioRef.current && progressFillRef.current && timeDisplayRef.current) {
                const current = editorAudioRef.current.currentTime;
                // Update DOM directly to avoid expensive React re-renders
                if (audioDuration > 0 && audioDuration !== Infinity) {
                    progressFillRef.current.style.width = `${(current / audioDuration) * 100}%`;
                }
                timeDisplayRef.current.innerText = formatAudioTime(current);
            }
            if (audioPlaying) frameId = requestAnimationFrame(updateProgress);
        };
        if (audioPlaying) {
            frameId = requestAnimationFrame(updateProgress);
        }
        return () => {
            if (frameId) cancelAnimationFrame(frameId);
        };
    }, [audioPlaying, audioDuration]);

    const toggleAudio = () => {
        const audio = editorAudioRef.current;
        if (!audio) return;

        if (audioPlaying) {
            audio.pause();
            setAudioPlaying(false);
        } else {
            audio.play().then(() => setAudioPlaying(true)).catch((e: any) => console.log(e));
        }
    };

    const seekAudio = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!editorAudioRef.current || !audioDuration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        editorAudioRef.current.currentTime = pct * audioDuration;
        setAudioTime(pct * audioDuration);
    };

    const handleAudioLoadedMetadata = () => {
        const audio = editorAudioRef.current;
        if (!audio) return;
        if (audio.duration === Infinity || isNaN(audio.duration)) {
            audio.currentTime = 1e10;
            audio.ontimeupdate = () => {
                audio.ontimeupdate = null;
                setAudioDuration(audio.duration);
                audio.currentTime = 0;
            };
        } else {
            setAudioDuration(audio.duration);
        }
    };

    // Derived title logic
    const derivedTitle = useMemo(() => {
        // 1. Título del store — GlobalAudioProcessor lo extrae del # h1 del LLM.
        //    Prioridad máxima: evita que "## 1. Summary" / "## 1. Zusammenfassung"
        //    sean confundidas con el título cuando el idioma no es español.
        if (title) return title;

        // 2. Primer # h1 real en el contenido (no ## secciones)
        const h1Match = editedNotes.match(/^\s*#\s+([^\n]+)/m);
        if (h1Match) return h1Match[1].trim().replace(/\*\*/g, '');

        // 3. Fallback al nombre de archivo
        return file?.name?.replace(/\.[^.]+$/, '') || 'Untitled Note';
    }, [title, editedNotes, file]);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(showTranscript ? transcription : editedNotes);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleDownload = async () => {
        setDownloading(true);
        try {
            let finalContent = showTranscript ? transcription : editedNotes;

            if (!title && !showTranscript) {
                let cleaned = finalContent.replace(/^## T[íi]tulo\s*\n+[^\n]+\n*/m, '');

                if (cleaned === finalContent) {
                    const firstLineMatch = finalContent.match(/^\s*#{1,2}\s+([^\n]+)/);
                    if (firstLineMatch) {
                        const candidate = firstLineMatch[1].trim();
                        if (candidate.replace(/\*\*/g, '') === derivedTitle) {
                            cleaned = finalContent.replace(/^\s*#{1,2}\s+[^\n]+\n*/, '');
                        }
                    }
                }
                finalContent = cleaned.trim();
            }

            await generatePdf({
                title: derivedTitle,
                date: new Date().toLocaleDateString(locale === 'es' ? 'es-CL' : 'en-US'),
                duration: '',
                content: finalContent,
                style: pdfStyle,
                locale: locale,
            });
            setDownloaded(true);
            setTimeout(() => setDownloaded(false), 3000);
        } catch (err) {
            console.error('PDF generation error:', err);
        } finally {
            setDownloading(false);
        }
    };

    // Estilos de preview mejorados - escala aumentada para mejor legibilidad
    const previewStyles = useMemo(() => {
        const isDark = theme === 'dark';

        if (pdfStyle === 'academico') {
            return {
                font: '"Georgia", "Times New Roman", serif',
                titleSize: '2.2rem',
                titleWeight: '700',
                titleColor: isDark ? '#cbd5e1' : 'rgb(0, 51, 102)',
                titleLineHeight: '1.3',
                titleMargin: '0 0 0.75rem 0',

                h1Size: '1.5rem',
                h1Weight: '700',
                h1Margin: '2.5rem 0 1rem 0',

                h2Size: '1.25rem',
                h2Weight: '700',
                h2Margin: '2rem 0 0.75rem 0',
                h2Border: isDark ? '1px solid rgba(203, 213, 225, 0.3)' : '1px solid rgb(0, 51, 102)',
                h2Padding: '0 0 0.5rem 0',

                h3Size: '1.1rem',
                h3Weight: '700',
                h3Margin: '1.5rem 0 0.6rem 0',

                bodySize: '1rem',
                bodyColor: isDark ? 'rgba(248, 250, 252, 0.85)' : 'rgb(50, 50, 50)',
                bodyMargin: '0 0 1rem 0',
                bodyLineHeight: '1.65',

                listMargin: '0.5rem 0',

                metaColor: isDark ? 'rgba(203, 213, 225, 0.6)' : 'rgb(130, 130, 130)',
                metaSize: '0.875rem',

                separatorColor: isDark ? 'rgba(203, 213, 225, 0.3)' : 'rgb(0, 51, 102)',
                separatorWidth: '0.6px',
                separatorMargin: '1rem 0',

                bg: isDark ? 'var(--bg-elevated)' : '#fff',
            };
        } else if (pdfStyle === 'cornell') {
            return {
                font: '"Outfit", sans-serif',
                titleSize: '2.5rem',
                titleWeight: '700',
                titleColor: isDark ? '#fafafa' : 'rgb(17, 24, 39)',
                titleLineHeight: '1.25',
                titleMargin: '0 0 0.75rem 0',

                h1Size: '1.75rem',
                h1Weight: '700',
                h1Margin: '2.5rem 0 1rem 0',

                h2Size: '1rem',
                h2Weight: '700',
                h2Margin: '1.25rem 0 0.75rem 0',
                h2Border: 'none',
                h2Padding: '0',

                h3Size: '0.95rem',
                h3Weight: '700',
                h3Margin: '1rem 0 0.6rem 0',
                h3Color: isDark ? 'rgba(250, 250, 250, 0.8)' : 'rgb(55, 65, 81)',

                bodySize: '0.95rem',
                bodyColor: isDark ? 'rgba(248, 250, 252, 0.85)' : 'rgb(50, 50, 50)',
                bodyMargin: '0 0 1rem 0',
                bodyLineHeight: '1.6',

                listMargin: '0.5rem 0',

                metaColor: isDark ? 'rgba(203, 213, 225, 0.6)' : 'rgb(107, 114, 128)',
                metaSize: '0.875rem',

                headerBg: isDark ? 'rgba(55, 65, 81, 0.3)' : 'rgb(249, 250, 251)',
                headerPadding: '2rem',

                columnDivider: isDark ? 'rgba(209, 213, 219, 0.2)' : 'rgb(209, 213, 219)',
                columnWidth: '30%',

                bg: isDark ? 'var(--bg-elevated)' : '#fff',
            };
        } else { // minimalista
            return {
                font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
                titleSize: '2.25rem',
                titleWeight: '700',
                titleColor: isDark ? '#fafafa' : '#000000',
                titleLineHeight: '1.3',
                titleMargin: '0 0 0.75rem 0',

                h1Size: '1.75rem',
                h1Weight: '700',
                h1Margin: '2.5rem 0 1rem 0',

                h2Size: '1.3rem',
                h2Weight: '700',
                h2Margin: '2rem 0 0.75rem 0',
                h2Border: 'none',
                h2Padding: '0',

                h3Size: '1.1rem',
                h3Weight: '700',
                h3Margin: '1.5rem 0 0.6rem 0',

                bodySize: '1rem',
                bodyColor: isDark ? 'rgba(248, 250, 252, 0.85)' : 'rgb(50, 50, 50)',
                bodyMargin: '0 0 1rem 0',
                bodyLineHeight: '1.6',

                listMargin: '0.5rem 0',

                metaColor: isDark ? 'rgba(203, 213, 225, 0.6)' : 'rgb(140, 140, 140)',
                metaSize: '0.875rem',

                separatorColor: isDark ? 'rgba(200, 200, 200, 0.2)' : 'rgb(200, 200, 200)',
                separatorWidth: '0.4px',
                separatorMargin: '1rem 0',

                bg: isDark ? 'var(--bg-elevated)' : '#fff',
            };
        }
    }, [pdfStyle, theme]);

    const previewHtml = useMemo(() => {
        const styles = previewStyles;

        // Remover título del contenido
        let contentToRender = editedNotes.replace(/^## T[íi]tulo\s*\n+[^\n]+\n*/m, '').trim();

        if (contentToRender === editedNotes.trim()) {
            const firstLineMatch = editedNotes.match(/^\s*#{1,2}\s+([^\n]+)/);
            if (firstLineMatch && firstLineMatch[1].trim().replace(/\*\*/g, '') === derivedTitle) {
                contentToRender = editedNotes.replace(/^\s*#{1,2}\s+[^\n]+\n*/, '').trim();
            }
        }

        const lines = contentToRender.split('\n');
        let processedHtml = '';
        let listBuffer: string[] = [];
        let isCornellCue = false;

        const flushList = () => {
            if (listBuffer.length > 0) {
                const listStyle = pdfStyle === 'cornell' && !isCornellCue ?
                    `margin-left: ${styles.columnWidth}; padding-left: 1.5rem;` :
                    'padding-left: 1.5rem;';
                processedHtml += `<ul style="list-style:disc;${listStyle}margin:0.5rem 0;">${listBuffer.join('')}</ul>`;
                listBuffer = [];
            }
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) {
                flushList();
                continue;
            }

            // Headers
            if (line.startsWith('### ')) {
                flushList();
                const text = line.replace('### ', '').replace(/\*\*/g, '');
                const h3Color = pdfStyle === 'cornell' ? (styles.h3Color || styles.titleColor) : styles.titleColor;

                if (pdfStyle === 'cornell') {
                    processedHtml += `<h3 style="font-family:${styles.font};font-size:${styles.h3Size};font-weight:${styles.h3Weight};margin:${styles.h3Margin};color:${h3Color};width:${styles.columnWidth};float:left;clear:left;padding-right:1rem;">${text}</h3>`;
                    isCornellCue = true;
                } else {
                    processedHtml += `<h3 style="font-family:${styles.font};font-size:${styles.h3Size};font-weight:${styles.h3Weight};margin:${styles.h3Margin};color:${h3Color};">${text}</h3>`;
                }
            } else if (line.startsWith('## ')) {
                flushList();
                const text = line.replace('## ', '').replace(/\*\*/g, '');

                if (pdfStyle === 'cornell') {
                    processedHtml += `<h2 style="font-family:${styles.font};font-size:${styles.h2Size};font-weight:${styles.h2Weight};margin:${styles.h2Margin};color:${styles.titleColor};width:${styles.columnWidth};float:left;clear:left;padding-right:1rem;">${text}</h2>`;
                    isCornellCue = true;
                } else {
                    const borderStyle = pdfStyle === 'academico' ? `border-bottom:${styles.h2Border};padding-bottom:${styles.h2Padding};` : '';
                    processedHtml += `<h2 style="font-family:${styles.font};font-size:${styles.h2Size};font-weight:${styles.h2Weight};margin:${styles.h2Margin};color:${styles.titleColor};${borderStyle}">${text}</h2>`;
                    // Salto de línea explícito (Spacer) para asegurar separación visual
                    processedHtml += `<div style="height:1.25rem;width:100%;display:block;"></div>`;
                }
            } else if (line.startsWith('# ')) {
                flushList();
                const text = line.replace('# ', '').replace(/\*\*/g, '');
                processedHtml += `<h1 style="font-family:${styles.font};font-size:${styles.h1Size};font-weight:${styles.h1Weight};margin:${styles.h1Margin};color:${styles.titleColor};line-height:${styles.titleLineHeight};">${text}</h1>`;
                isCornellCue = false;
            }
            // Lists
            else if (line.startsWith('- ') || line.startsWith('• ')) {
                const itemText = line.replace(/^[-•] /, '').replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;">$1</strong>');
                listBuffer.push(`<li style="margin:${styles.listMargin};font-size:${styles.bodySize};color:${styles.bodyColor};line-height:${styles.bodyLineHeight};">${itemText}</li>`);
            }
            // Paragraphs
            else {
                flushList();
                const formattedLine = line
                    .replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:700;">$1</strong>')
                    .replace(/\*(.+?)\*/g, '<em>$1</em>');

                const pStyle = pdfStyle === 'cornell' && !isCornellCue ?
                    `margin-left: ${styles.columnWidth}; padding-left: 1.5rem;` : '';

                processedHtml += `<p style="${pStyle}margin:${styles.bodyMargin};font-size:${styles.bodySize};color:${styles.bodyColor};line-height:${styles.bodyLineHeight};">${formattedLine}</p>`;
                isCornellCue = false;
            }
        }
        flushList();

        // Construir HTML final con header
        let headerHtml = '';

        // Cornell: Header con fondo gris - CENTRADO
        if (pdfStyle === 'cornell') {
            headerHtml = `
                <div style="background:${styles.headerBg};padding:${styles.headerPadding};margin:-2rem -2rem 2rem -2rem;border-bottom:1px solid ${styles.columnDivider};">
                    <h1 style="font-family:${styles.font};font-size:${styles.titleSize};font-weight:${styles.titleWeight};color:${styles.titleColor};line-height:${styles.titleLineHeight};margin:${styles.titleMargin};text-align:left;">${derivedTitle}</h1>
                    <div style="font-size:${styles.metaSize};color:${styles.metaColor};margin-top:0.5rem;">
                        ${new Date().toLocaleDateString(locale === 'es' ? 'es-CL' : 'en-US')} • Compendium Notes
                    </div>
                </div>
            `;
        }
        // Académico: Título con línea debajo
        else if (pdfStyle === 'academico') {
            headerHtml = `
                <h1 style="font-family:${styles.font};font-size:${styles.titleSize};font-weight:${styles.titleWeight};color:${styles.titleColor};line-height:${styles.titleLineHeight};margin:${styles.titleMargin};">${derivedTitle}</h1>
                <div style="font-size:${styles.metaSize};color:${styles.metaColor};margin:0.5rem 0;">
                    ${new Date().toLocaleDateString(locale === 'es' ? 'es-CL' : 'en-US')} • Compendium Notes
                </div>
                <div style="border-bottom:${styles.separatorWidth} solid ${styles.separatorColor};margin:${styles.separatorMargin};"></div>
            `;
        }
        // Minimalista: Título simple con línea sutil
        else {
            headerHtml = `
                <h1 style="font-family:${styles.font};font-size:${styles.titleSize};font-weight:${styles.titleWeight};color:${styles.titleColor};line-height:${styles.titleLineHeight};margin:${styles.titleMargin};">${derivedTitle}</h1>
                <div style="font-size:${styles.metaSize};color:${styles.metaColor};margin:0.5rem 0;">
                    ${new Date().toLocaleDateString(locale === 'es' ? 'es-CL' : 'en-US')} • Compendium Notes
                </div>
                <div style="border-bottom:${styles.separatorWidth} solid ${styles.separatorColor};margin:${styles.separatorMargin};"></div>
            `;
        }

        return headerHtml + processedHtml;
    }, [editedNotes, pdfStyle, derivedTitle, locale, previewStyles]);

    return (
        <div className="flex flex-col h-full rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 sm:px-4 sm:py-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] overflow-x-auto sm:overflow-visible custom-scrollbar gap-2">

                {/* Left Group: Tabs & Title */}
                <div className="flex items-center gap-3 min-w-0">
                    {/* Tabs (mobile) */}
                    <div className="flex items-center gap-1 sm:hidden shrink-0">
                        <button
                            onClick={() => setActiveTab('edit')}
                            className="flex items-center gap-1.5 p-2 rounded-md transition-colors"
                            style={{
                                background: activeTab === 'edit' && !showTranscript ? 'var(--bg-tertiary)' : 'transparent',
                                color: activeTab === 'edit' ? 'var(--text-primary)' : 'var(--text-muted)',
                            }}
                            title={t('app.editor.markdown', locale)}
                        >
                            <PenLine size={16} />
                        </button>
                        <button
                            onClick={() => setActiveTab('preview')}
                            className="flex items-center gap-1.5 p-2 rounded-md transition-colors"
                            style={{
                                background: activeTab === 'preview' && !showTranscript ? 'var(--bg-tertiary)' : 'transparent',
                                color: activeTab === 'preview' ? 'var(--text-primary)' : 'var(--text-muted)',
                            }}
                            title={t('app.editor.preview', locale)}
                        >
                            <Eye size={16} />
                        </button>
                    </div>

                    {/* Title Display */}
                    <div className="hidden sm:block min-w-0">
                        <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)', maxWidth: '200px' }}>
                            {title || file?.name?.replace(/\.[^.]+$/, '') || t('app.editor.markdown', locale)}
                        </h3>
                    </div>
                </div>

                {/* Right Group: Actions */}
                <div className="flex items-center gap-2 shrink-0">
                    {/* 1. Copy */}
                    <button
                        onClick={handleCopy}
                        className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md transition-colors whitespace-nowrap"
                        style={{
                            color: copied ? '#34d399' : 'var(--text-muted)',
                            border: `1px solid ${copied ? 'rgba(16,185,129,0.3)' : 'var(--border-subtle)'}`,
                        }}
                        title={t('app.editor.copy', locale)}
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        <span className="hidden md:inline">{copied ? t('app.editor.copied', locale) : t('app.editor.copy', locale)}</span>
                    </button>

                    {/* 2. Transcript */}
                    <button
                        onClick={() => setShowTranscript(!showTranscript)}
                        className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md transition-colors whitespace-nowrap"
                        style={{
                            background: showTranscript ? 'var(--accent-subtle)' : 'transparent',
                            color: showTranscript ? 'var(--accent)' : 'var(--text-muted)',
                            border: `1px solid ${showTranscript ? 'var(--accent)' : 'var(--border-subtle)'}`
                        }}
                        title={locale === 'es' ? 'Ver transcripción original' : 'View original transcript'}
                    >
                        <MessageSquareText size={14} />
                        <span className="hidden md:inline">{locale === 'es' ? 'Transcripción' : 'Transcript'}</span>
                    </button>

                    {/* 2.5 Re-summarize */}
                    {transcription && (
                        <div className="relative">
                            <button
                                onClick={() => setShowResummarize(!showResummarize)}
                                disabled={isResummarizing}
                                className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md transition-colors whitespace-nowrap"
                                style={{
                                    color: isResummarizing ? 'var(--accent)' : 'var(--text-muted)',
                                    border: `1px solid var(--border-subtle)`,
                                }}
                                title={t('app.editor.resummarize', locale)}
                            >
                                {isResummarizing
                                    ? <Loader2 size={14} className="animate-spin" />
                                    : <Sparkles size={14} />}
                                <span className="hidden md:inline">
                                    {isResummarizing ? t('app.editor.resummarizing', locale) : t('app.editor.resummarize', locale)}
                                </span>
                            </button>

                            {showResummarize && !isResummarizing && (
                                <>
                                    <div
                                        className="fixed inset-0 z-40 bg-black/20 sm:bg-transparent backdrop-blur-[1px] sm:backdrop-blur-none"
                                        onClick={() => setShowResummarize(false)}
                                    />
                                    <div
                                        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] max-w-xs sm:absolute sm:top-full sm:right-0 sm:left-auto sm:translate-x-0 sm:translate-y-1 sm:w-56 p-1 rounded-lg shadow-2xl border border-[var(--border-subtle)] z-50 flex flex-col"
                                        style={{ background: 'var(--bg-secondary)', overflow: 'visible' }}
                                    >
                                        <div className="px-3 py-2 text-xs font-semibold text-[var(--text-muted)] border-b border-[var(--border-subtle)] mb-1">
                                            {t('app.summary.level', locale)}
                                        </div>
                                        {(['short', 'medium', 'long'] as const).map((level) => (
                                            <button
                                                key={level}
                                                onClick={async () => {
                                                    setShowResummarize(false);
                                                    setIsResummarizing(true);
                                                    try {
                                                        const key = activeKey();
                                                        if (!key) throw new Error('API Key missing');

                                                        const { notes } = await providerFor(provider).organize({
                                                            transcription,
                                                            apiKey: key,
                                                            summaryLevel: level,
                                                            outputLanguage,
                                                            onStep: () => { /* el botón ya muestra que trabaja */ },
                                                        });
                                                        const { title: newTitle, body } = splitTitle(notes);
                                                        if (newTitle) setTitle(newTitle);
                                                        setOrganizedNotes(body);
                                                        setSummaryLevel(level);
                                                    } catch (err: any) {
                                                        console.error('Re-summarize error:', err);
                                                    } finally {
                                                        setIsResummarizing(false);
                                                    }
                                                }}
                                                className="text-left px-3 py-3 sm:py-2 text-sm sm:text-xs font-medium rounded-md transition-colors"
                                                style={{
                                                    color: summaryLevel === level ? 'var(--accent)' : 'var(--text-primary)',
                                                    background: summaryLevel === level ? 'var(--accent-subtle)' : 'transparent',
                                                }}
                                            >
                                                <span className="block">{t(`app.summary.${level}` as any, locale)}</span>
                                                <span className="block text-[10px] opacity-60 mt-0.5">{t(`app.summary.${level}.desc` as any, locale)}</span>
                                            </button>
                                        ))}

                                        <div className="px-3 py-2 mt-1 text-xs font-semibold text-[var(--text-muted)] border-t border-[var(--border-subtle)]">
                                            {t('app.lang.output', locale)}
                                        </div>
                                        <div className="px-1 pb-1">
                                            <SearchableLanguageSelect />
                                        </div>

                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    <div className="w-px h-4 mx-1 hidden sm:block" style={{ background: 'var(--border-subtle)' }}></div>

                    {/* 3. Style Selector */}
                    <div className="relative">
                        <button
                            onClick={() => setIsStyleOpen(!isStyleOpen)}
                            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)] transition-colors whitespace-nowrap"
                            style={{ color: 'var(--text-secondary)' }}
                            title={t('app.config.pdfstyle', locale)}
                        >
                            <Palette size={14} className="shrink-0" />
                            <span className="capitalize hidden sm:inline text-xs font-medium">{t(`app.style.${pdfStyle}` as any, locale)}</span>
                            <div className="hidden sm:block opacity-50">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                            </div>
                        </button>

                        {isStyleOpen && (
                            <>
                                <div
                                    className="fixed inset-0 z-40 bg-black/20 sm:bg-transparent backdrop-blur-[1px] sm:backdrop-blur-none"
                                    onClick={() => setIsStyleOpen(false)}
                                />
                                <div
                                    className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] max-w-xs sm:absolute sm:top-full sm:right-0 sm:left-auto sm:translate-x-0 sm:translate-y-1 sm:w-36 p-1 rounded-lg shadow-2xl border border-[var(--border-subtle)] overflow-hidden z-50 flex flex-col"
                                    style={{ background: 'var(--bg-secondary)' }}
                                >
                                    <div className="px-3 py-2 text-xs font-semibold text-[var(--text-muted)] border-b border-[var(--border-subtle)] mb-1 sm:hidden">
                                        {t('app.config.pdfstyle', locale)}
                                    </div>
                                    {(['minimalista', 'academico', 'cornell'] as const).map((style) => (
                                        <button
                                            key={style}
                                            onClick={() => {
                                                setPdfStyle(style);
                                                setIsStyleOpen(false);
                                            }}
                                            className="text-left px-3 py-3 sm:py-2 text-sm sm:text-xs font-medium rounded-md transition-colors flex items-center justify-between"
                                            style={{
                                                color: pdfStyle === style ? 'var(--accent)' : 'var(--text-primary)',
                                                background: pdfStyle === style ? 'var(--accent-subtle)' : 'transparent',
                                            }}
                                        >
                                            {t(`app.style.${style}` as any, locale)}
                                            {pdfStyle === style && <Check size={16} className="sm:w-3 sm:h-3" />}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    <button
                        onClick={reset}
                        className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md transition-all duration-300 whitespace-nowrap group relative overflow-hidden"
                        style={{
                            color: 'var(--text-primary)',
                            border: '1.5px solid var(--accent)',
                            background: 'var(--accent-subtle)',
                        }}
                        title={t('app.editor.new', locale)}
                    >
                        <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
                        <RotateCcw size={14} className="relative z-10 group-hover:rotate-180 transition-transform duration-500" />
                        <span className="hidden md:inline relative z-10 font-medium">{t('app.editor.new', locale)}</span>
                    </button>

                    <div className="w-px h-4 mx-1 hidden sm:block" style={{ background: 'var(--border-subtle)' }}></div>

                    <button
                        onClick={async () => {
                            let finalContent = showTranscript ? transcription : editedNotes;
                            if (!title && !showTranscript) {
                                finalContent = finalContent.replace(/^## T[íi]tulo\s*\n+[^\n]+\n*/m, '').trim();
                                if (finalContent === editedNotes.trim()) {
                                    const firstLineMatch = editedNotes.match(/^\s*#{1,2}\s+([^\n]+)/);
                                    if (firstLineMatch && firstLineMatch[1].trim().replace(/\*\*/g, '') === derivedTitle) {
                                        finalContent = editedNotes.replace(/^\s*#{1,2}\s+[^\n]+\n*/, '').trim();
                                    }
                                }
                            }
                            const url = await generatePdf({
                                title: derivedTitle,
                                date: new Date().toLocaleDateString(locale === 'es' ? 'es-CL' : 'en-US'),
                                duration: '',
                                content: finalContent,
                                style: pdfStyle,
                                locale: locale,
                            }, 'blob');
                            if (url && typeof url === 'string') window.open(url, '_blank');
                        }}
                        className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md transition-colors whitespace-nowrap"
                        style={{ color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                        title={locale === 'es' ? 'Ver PDF' : 'View PDF'}
                    >
                        <FileText size={14} />
                        <span className="hidden md:inline">PDF</span>
                    </button>

                    <button
                        onClick={handleDownload}
                        disabled={downloading}
                        className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md font-medium text-white transition-colors whitespace-nowrap"
                        style={{ background: downloaded ? '#10b981' : 'var(--accent)' }}
                    >
                        {downloading ? <Loader2 size={14} className="animate-spin" /> : downloaded ? <Check size={14} /> : <Download size={14} />}
                        <span className="hidden sm:inline">
                            {downloading ? t('app.editor.downloading', locale) : downloaded ? t('app.editor.downloaded', locale) : t('app.editor.download', locale)}
                        </span>
                    </button>
                </div>
            </div>

            {/* Stats Bar (Dashboard Header) */}
            {!showTranscript && (
                <div
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-6 py-2.5 border-b"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}
                >
                    {/* Left: Stats */}
                    <div className="flex items-center gap-4 text-[10px] overflow-x-auto" style={{ color: 'var(--text-muted)' }}>
                        <span className="flex items-center gap-1 whitespace-nowrap">
                            <Type size={11} />
                            {stats.words.toLocaleString()} {t('app.editor.words' as any, locale)}
                        </span>
                        <span className="flex items-center gap-1 whitespace-nowrap">
                            <Clock size={11} />
                            ~{stats.readingTime} {t('app.editor.reading' as any, locale)}
                        </span>
                        <span className="flex items-center gap-1 whitespace-nowrap">
                            <Hash size={11} />
                            {stats.sections} {t('app.editor.sections' as any, locale)}
                        </span>
                        <span
                            className="px-1.5 py-0.5 rounded-sm text-[9px] font-semibold uppercase tracking-wider whitespace-nowrap"
                            style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                        >
                            {t(`app.summary.${summaryLevel}` as any, locale)}
                        </span>
                    </div>
                </div>
            )}

            {/* Content */}
            <div className="flex-1 flex min-h-0 relative">
                {showTranscript ? (
                    <div className="absolute inset-0 p-4 sm:p-5 pb-28 sm:pb-24 overflow-auto custom-scrollbar">
                        <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {transcription}
                        </pre>
                    </div>
                ) : (
                    <>
                        {/* Markdown Editor */}
                        <div className={`flex-1 min-h-0 ${activeTab !== 'edit' ? 'hidden sm:block' : ''} transition-all duration-300 relative group pb-20`}>
                            <div className="absolute inset-0 border-2 border-transparent pointer-events-none group-focus-within:border-[var(--accent)]/10 group-focus-within:bg-[var(--accent)]/[0.01] transition-all duration-500 rounded-lg"></div>
                            <div className="absolute top-0 left-0 right-0 h-1 bg-linear-to-r from-transparent via-[var(--accent)] to-transparent opacity-0 group-focus-within:opacity-100 transition-all duration-500 z-20"></div>

                            <textarea
                                id="notes-editor"
                                name="notes-editor"
                                value={editedNotes}
                                onChange={(e) => setEditedNotes(e.target.value)}
                                className="w-full h-full resize-none bg-transparent p-4 sm:p-5 pb-20 text-sm font-mono focus:outline-hidden custom-scrollbar relative z-10"
                                style={{ color: 'var(--text-primary)', lineHeight: 1.7 }}
                                spellCheck={false}
                            />
                        </div>

                        {/* Divider */}
                        <div className="hidden sm:block w-px" style={{ background: 'var(--border-subtle)' }}></div>

                        {/* Preview */}
                        <div className={`flex-1 min-h-0 overflow-auto bg-[var(--bg-tertiary)] dark:bg-[var(--bg-primary)] p-4 sm:p-6 pb-20 custom-scrollbar ${activeTab !== 'preview' ? 'hidden sm:block' : ''}`}>
                            <div
                                className="mx-auto shadow-xl rounded-xs min-h-full max-w-[800px]"
                                style={{
                                    background: previewStyles.bg,
                                    border: '1px solid var(--border-subtle)',
                                    fontFamily: previewStyles.font,
                                    padding: pdfStyle === 'cornell' ? '2rem' : '3rem 2.5rem'
                                }}
                            >
                                <div
                                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                                />
                            </div>
                        </div>
                    </>
                )}

                {/* Footer con botón Nuevo Documento y Audio Player - Barra sólida SIEMPRE VISIBLE */}
                <div
                    className="absolute bottom-0 left-0 right-0 border-t"
                    style={{
                        background: 'var(--bg-secondary)',
                        borderColor: 'var(--border-subtle)'
                    }}
                >
                    <div className="max-w-7xl mx-auto px-3 py-2.5 sm:px-6 sm:py-3" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}>
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 w-full">

                            {/* Audio Player (50%) */}
                            <div className="w-full sm:w-1/2">
                                {file && audioUrl ? (
                                    <div
                                        className="flex items-center gap-3 px-4 py-2.5 rounded-lg border w-full"
                                        style={{
                                            background: 'var(--bg-tertiary)',
                                            borderColor: 'var(--border-subtle)'
                                        }}
                                    >
                                        <button
                                            onClick={toggleAudio}
                                            className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors shadow-xs"
                                            style={{ background: 'var(--accent)', color: '#fff' }}
                                        >
                                            {audioPlaying ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" style={{ marginLeft: 2 }} />}
                                        </button>

                                        <div className="flex-1 flex flex-col justify-center min-w-[100px] sm:min-w-0">
                                            <div
                                                className="h-1.5 rounded-full cursor-pointer relative overflow-hidden"
                                                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}
                                                onClick={seekAudio}
                                            >
                                                <div
                                                    ref={progressFillRef}
                                                    className="absolute inset-y-0 left-0 rounded-full transition-all duration-150"
                                                    style={{ width: `${audioDuration > 0 && audioDuration !== Infinity ? (audioTime / audioDuration) * 100 : 0}%`, background: 'var(--accent)' }}
                                                />
                                            </div>
                                            <div className="flex justify-between mt-1.5 text-[9.5px] font-mono font-medium tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                                <span ref={timeDisplayRef}>{formatAudioTime(audioTime)}</span>
                                                <span>{audioDuration === Infinity ? 'En vivo' : formatAudioTime(audioDuration)}</span>
                                            </div>
                                        </div>

                                        {/* Volume Slider visible on all devices */}
                                        <div className="flex items-center gap-1.5 shrink-0 group ml-2">
                                            <button onClick={() => {
                                                const newV = volume > 0 ? 0 : 1;
                                                setVolume(newV);
                                                if (editorAudioRef.current) editorAudioRef.current.volume = newV;
                                            }}>
                                                {volume === 0 ? <VolumeX size={14} style={{ color: 'var(--text-muted)' }} /> : <Volume2 size={14} style={{ color: 'var(--text-muted)' }} />}
                                            </button>
                                            <input
                                                type="range"
                                                min="0" max="1" step="0.01"
                                                value={volume}
                                                onChange={(e) => {
                                                    const v = parseFloat(e.target.value);
                                                    setVolume(v);
                                                    if (editorAudioRef.current) editorAudioRef.current.volume = v;
                                                }}
                                                className="w-12 h-1 rounded-full appearance-none bg-[var(--bg-primary)] border border-[var(--border-subtle)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                ) : (
                                    <div className="h-[54px] rounded-lg border border-dashed flex items-center justify-center text-xs text-[var(--text-muted)] w-full" style={{ borderColor: 'var(--border-subtle)' }}>
                                        No audio available
                                    </div>
                                )}
                            </div>

                            <audio
                                ref={editorAudioRef}
                                src={audioUrl || undefined}
                                className="hidden"
                                onLoadedMetadata={handleAudioLoadedMetadata}
                                onEnded={() => {
                                    setAudioPlaying(false);
                                    setAudioTime(0);
                                }}
                            />

                            {/* New Document Button (50%) */}
                            <div className="w-full sm:w-1/2">
                                <button
                                    onClick={reset}
                                    className="w-full flex items-center justify-center gap-2.5 px-4 h-[54px] rounded-lg font-semibold transition-all duration-200 group relative overflow-hidden shadow-xs"
                                    style={{
                                        background: 'var(--accent)',
                                        color: '#fff',
                                    }}
                                >
                                    {/* Hover shine effect */}
                                    <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700"></div>

                                    <RotateCcw size={16} className="relative z-10 group-hover:rotate-180 transition-transform duration-500" />
                                    <span className="relative z-10 text-sm">
                                        {locale === 'es' ? 'Nuevo Documento' : 'New Document'}
                                    </span>
                                </button>
                            </div>

                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
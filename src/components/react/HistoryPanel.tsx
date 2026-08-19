import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
    X, Search, FileText, FileAudio, Trash2, Download, ChevronDown,
    Loader2, AlertTriangle, Clock, Inbox,
} from 'lucide-react';
import { useAppStore } from '../../lib/store';
import { t } from '../../lib/i18n';
import { listHistory, deleteProject, loadProject, loadProjectAudio, type HistoryEntry } from '../../lib/db';

/**
 * "Ver archivos": todo lo transcrito hasta ahora, en un sitio.
 *
 * Hasta ahora la base de datos guardaba cada proyecto con su audio, su
 * transcripción y sus apuntes, pero la interfaz sólo sabía enseñar UNO: el
 * último. Al empezar una clase nueva, la anterior seguía ocupando disco sin que
 * hubiera forma de volver a ella ni de borrarla. Aquí está esa lista.
 */

/** Tamaño legible, o cadena vacía si no se sabe: "NaN KB" no informa de nada. */
const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
};

/** Fecha corta y humana: "Hoy · 14:32", "12 mar 2026". */
const formatDate = (ts: number, locale: 'es' | 'en'): string => {
    const d = new Date(ts);
    const hora = d.toLocaleTimeString(locale === 'es' ? 'es-ES' : 'en-US', { hour: '2-digit', minute: '2-digit' });

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const dayMs = 86_400_000;

    if (ts >= midnight.getTime()) return `${t('app.history.today', locale)} · ${hora}`;
    if (ts >= midnight.getTime() - dayMs) return `${t('app.history.yesterday', locale)} · ${hora}`;

    return d.toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-US', {
        day: 'numeric', month: 'short', year: 'numeric',
    });
};

const STATUS_STYLE: Record<HistoryEntry['status'], { key: string; color: string; bg: string }> = {
    done: { key: 'app.history.status.done', color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
    processing: { key: 'app.history.status.processing', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
    error: { key: 'app.history.status.error', color: '#f87171', bg: 'rgba(239,68,68,0.12)' },
    cancelled: { key: 'app.history.status.cancelled', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
    draft: { key: 'app.history.status.draft', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
};

export default function HistoryPanel() {
    const { locale, setHistoryOpen, openFromHistory, currentProjectId, setError } = useAppStore();

    const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
    const [query, setQuery] = useState('');
    /** Id cuya transcripción está desplegada, con su texto ya cargado. */
    const [expanded, setExpanded] = useState<{ id: number; text: string } | null>(null);
    const [loadingId, setLoadingId] = useState<number | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

    const refresh = useCallback(async () => {
        try {
            setEntries(await listHistory());
        } catch (e) {
            console.error('[History] No se pudo leer el historial:', e);
            setEntries([]);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    // Escape cierra, igual que en el resto de la app.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHistoryOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setHistoryOpen]);

    const filtered = useMemo(() => {
        if (!entries) return null;
        const q = query.trim().toLowerCase();
        if (!q) return entries;
        return entries.filter((e) =>
            e.title.toLowerCase().includes(q) || (e.audio?.name ?? '').toLowerCase().includes(q));
    }, [entries, query]);

    /** Suma de los audios guardados: lo que esta app ocupa de verdad en disco. */
    const totalBytes = useMemo(
        () => (entries ?? []).reduce((sum, e) => sum + (e.audio?.size ?? 0), 0),
        [entries]);

    const handleOpen = async (entry: HistoryEntry) => {
        setLoadingId(entry.id);
        try {
            const ok = await openFromHistory(entry.id);
            // Se pudo borrar desde otra pestaña entre el listado y el clic.
            if (!ok) {
                setError(t('app.history.gone', locale));
                await refresh();
            }
        } catch (e: any) {
            console.error('[History] No se pudo abrir el proyecto:', e);
            setError(e?.message || t('app.history.gone', locale));
        } finally {
            setLoadingId(null);
        }
    };

    const handleTranscript = async (entry: HistoryEntry) => {
        if (expanded?.id === entry.id) { setExpanded(null); return; }
        setLoadingId(entry.id);
        try {
            const data = await loadProject(entry.id);
            setExpanded({ id: entry.id, text: data?.transcription ?? '' });
        } catch (e) {
            console.error('[History] No se pudo leer la transcripción:', e);
        } finally {
            setLoadingId(null);
        }
    };

    const handleAudio = async (entry: HistoryEntry) => {
        setLoadingId(entry.id);
        try {
            const file = await loadProjectAudio(entry.id);
            if (!file) { setError(t('app.history.audio_gone', locale)); return; }

            // El objeto URL se libera en cuanto el navegador ha tomado el
            // archivo: dejarlo vivo ancla el Blob entero en memoria.
            const url = URL.createObjectURL(file);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (e) {
            console.error('[History] No se pudo descargar el audio:', e);
        } finally {
            setLoadingId(null);
        }
    };

    const handleDelete = async (entry: HistoryEntry) => {
        setLoadingId(entry.id);
        try {
            await deleteProject(entry.id);
            if (expanded?.id === entry.id) setExpanded(null);
            setConfirmDelete(null);
            await refresh();
        } catch (e: any) {
            console.error('[History] No se pudo borrar:', e);
            setError(e?.message || 'No se pudo eliminar');
        } finally {
            setLoadingId(null);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-20 sm:pt-24"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
            onClick={() => setHistoryOpen(false)}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: 8 }}
                transition={{ duration: 0.2 }}
                className="w-full max-w-2xl rounded-xl overflow-hidden flex flex-col max-h-[80vh]"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Cabecera */}
                <div
                    className="px-5 py-4 shrink-0"
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                    <div className="flex items-center justify-between mb-1">
                        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {t('app.history.title', locale)}
                            {entries && entries.length > 0 && (
                                <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
                                    {entries.length} {t('app.history.count', locale)}
                                    {totalBytes > 0 && ` · ${formatBytes(totalBytes)} ${t('app.history.storage', locale)}`}
                                </span>
                            )}
                        </h2>
                        <button
                            onClick={() => setHistoryOpen(false)}
                            className="p-1 rounded-md transition-colors"
                            style={{ color: 'var(--text-muted)' }}
                            aria-label={t('app.history.close', locale)}
                        >
                            <X size={16} />
                        </button>
                    </div>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {t('app.history.subtitle', locale)}
                    </p>

                    {entries && entries.length > 3 && (
                        <div className="relative mt-3">
                            <Search
                                size={14}
                                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                                style={{ color: 'var(--text-muted)' }}
                            />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={t('app.history.search', locale)}
                                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg outline-none"
                                style={{
                                    background: 'var(--bg-primary)',
                                    border: '1px solid var(--border-subtle)',
                                    color: 'var(--text-primary)',
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* Lista */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {filtered === null && (
                        <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-muted)' }}>
                            <Loader2 size={18} className="animate-spin" />
                        </div>
                    )}

                    {filtered !== null && filtered.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                            <Inbox size={28} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
                            <p className="text-sm font-medium mt-3" style={{ color: 'var(--text-secondary)' }}>
                                {query ? t('app.history.no_results', locale) : t('app.history.empty', locale)}
                            </p>
                            {!query && (
                                <p className="text-xs mt-1 max-w-xs" style={{ color: 'var(--text-muted)' }}>
                                    {t('app.history.empty.desc', locale)}
                                </p>
                            )}
                        </div>
                    )}

                    {filtered?.map((entry) => {
                        const status = STATUS_STYLE[entry.status];
                        const isBusy = loadingId === entry.id;
                        const isOpen = expanded?.id === entry.id;
                        const isCurrent = currentProjectId === entry.id;

                        return (
                            <div
                                key={entry.id}
                                className="px-5 py-3.5"
                                style={{
                                    borderBottom: '1px solid var(--border-subtle)',
                                    background: isCurrent ? 'var(--accent-subtle)' : 'transparent',
                                }}
                            >
                                <div className="flex items-start gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span
                                                className="text-sm font-medium truncate"
                                                style={{ color: 'var(--text-primary)' }}
                                                title={entry.title}
                                            >
                                                {entry.title}
                                            </span>
                                            <span
                                                className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                                                style={{ color: status.color, background: status.bg }}
                                            >
                                                {t(status.key as any, locale)}
                                            </span>
                                        </div>

                                        <div
                                            className="flex items-center gap-2.5 flex-wrap mt-1 text-[11px]"
                                            style={{ color: 'var(--text-muted)' }}
                                        >
                                            <span className="flex items-center gap-1">
                                                <Clock size={11} /> {formatDate(entry.updatedAt, locale)}
                                            </span>
                                            {entry.audio && (
                                                <span className="flex items-center gap-1 truncate max-w-[16rem]" title={entry.audio.name}>
                                                    <FileAudio size={11} className="shrink-0" />
                                                    <span className="truncate">{entry.audio.name}</span>
                                                    {formatBytes(entry.audio.size) && (
                                                        <span className="shrink-0">· {formatBytes(entry.audio.size)}</span>
                                                    )}
                                                </span>
                                            )}
                                            {entry.durationMinutes && <span>· {entry.durationMinutes} min</span>}
                                            {entry.provider && <span>· {entry.provider === 'gemini' ? 'Gemini' : 'Groq'}</span>}
                                            {entry.hasNotes
                                                ? <span>· {entry.noteWords.toLocaleString()} {t('app.history.words', locale)}</span>
                                                : (
                                                    <span className="flex items-center gap-1" style={{ color: '#fbbf24' }}>
                                                        <AlertTriangle size={11} /> {t('app.history.no_notes', locale)}
                                                    </span>
                                                )}
                                        </div>
                                    </div>

                                    {isBusy && <Loader2 size={14} className="animate-spin shrink-0 mt-1" style={{ color: 'var(--accent)' }} />}
                                </div>

                                {/* Acciones */}
                                <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                                    <button
                                        onClick={() => handleOpen(entry)}
                                        disabled={!entry.hasNotes || isBusy}
                                        className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        style={{
                                            color: entry.hasNotes ? 'var(--accent)' : 'var(--text-muted)',
                                            border: '1px solid var(--border-subtle)',
                                        }}
                                    >
                                        <FileText size={12} /> {t('app.history.open_notes', locale)}
                                    </button>

                                    <button
                                        onClick={() => handleTranscript(entry)}
                                        disabled={!entry.hasTranscription || isBusy}
                                        className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                                    >
                                        <ChevronDown
                                            size={12}
                                            style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                                        />
                                        {isOpen ? t('app.history.hide_transcript', locale) : t('app.history.transcript', locale)}
                                    </button>

                                    {entry.audio && (
                                        <button
                                            onClick={() => handleAudio(entry)}
                                            disabled={isBusy}
                                            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-40"
                                            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                                        >
                                            <Download size={12} /> {t('app.history.audio', locale)}
                                        </button>
                                    )}

                                    <div className="flex-1" />

                                    {/* El borrado no tiene vuelta atrás: la confirmación vive
                                        aquí mismo, en la fila, en vez de en un `confirm()`
                                        del navegador que bloquea toda la pestaña. */}
                                    {confirmDelete === entry.id ? (
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[11px]" style={{ color: '#f87171' }}>
                                                {t('app.history.delete_confirm', locale)}
                                            </span>
                                            <button
                                                onClick={() => handleDelete(entry)}
                                                disabled={isBusy}
                                                className="text-[11px] px-2 py-1.5 rounded-md font-medium"
                                                style={{ color: '#f87171', background: 'rgba(239,68,68,0.12)' }}
                                            >
                                                {t('app.history.delete_yes', locale)}
                                            </button>
                                            <button
                                                onClick={() => setConfirmDelete(null)}
                                                className="text-[11px] px-2 py-1.5 rounded-md"
                                                style={{ color: 'var(--text-muted)' }}
                                            >
                                                {t('app.history.delete_no', locale)}
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => setConfirmDelete(entry.id)}
                                            disabled={isBusy}
                                            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-40"
                                            style={{ color: 'var(--text-muted)' }}
                                            aria-label={t('app.history.delete', locale)}
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    )}
                                </div>

                                {isOpen && (
                                    <pre
                                        className="mt-2.5 p-3 rounded-lg text-[11px] leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto custom-scrollbar"
                                        style={{
                                            background: 'var(--bg-primary)',
                                            border: '1px solid var(--border-subtle)',
                                            color: 'var(--text-secondary)',
                                            fontFamily: 'inherit',
                                        }}
                                    >
                                        {expanded.text}
                                    </pre>
                                )}
                            </div>
                        );
                    })}
                </div>
            </motion.div>
        </motion.div>
    );
}

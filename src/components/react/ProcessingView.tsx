import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
    Check, AlertTriangle, Waves, Upload, Shrink,
    FileText, ChevronDown, Activity, RotateCw, Loader2,
} from 'lucide-react';
import { useAppStore } from '../../lib/store';
import { useProgress } from '../../lib/useProgress';
import {
    formatClock,
    type StageId, type StageState, type ChunkState, type ActivityEvent, type EventKind,
} from '../../lib/progress';
import { t } from '../../lib/i18n';
import { friendlyError } from '../../lib/friendly-errors';

/**
 * Vista única de progreso.
 *
 * Arriba, lo único que le importa a quien sólo quiere sus apuntes: qué está
 * pasando, cuánto falta y cuánta grabación lleva escuchada. Debajo, tras "Ver
 * detalles", el desglose ordenado de arriba abajo — pasos, fragmentos,
 * actividad —, en ese orden porque es el orden en el que se pregunta: "¿por
 * dónde va?", "¿qué trozo?", "¿qué ha pasado?".
 *
 * La versión anterior lo enseñaba todo a la vez y en horizontal: cuatro cajas
 * apretadas con cronómetros, una fila de barritas sin etiqueta, una ficha
 * técnica y un registro con dos filas de filtros. Había más pantalla dedicada a
 * elegir qué mirar que a decir cómo iba.
 */

const STAGE_META: Record<StageId, { icon: typeof Waves; es: string; en: string }> = {
    prepare: { icon: Shrink, es: 'Preparar', en: 'Prepare' },
    upload: { icon: Upload, es: 'Subir', en: 'Upload' },
    transcribe: { icon: Waves, es: 'Transcribir', en: 'Transcribe' },
    organize: { icon: FileText, es: 'Organizar', en: 'Organize' },
};

/** Segundos sin señal a partir de los cuales se explica la espera. */
const STALL_AFTER_MS = 8000;

function useTicker(activeMs = 1000) {
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((n) => n + 1), activeMs);
        return () => clearInterval(id);
    }, [activeMs]);
}

const mmss = (sec: number) =>
    `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- los pasos

/**
 * Los pasos, uno debajo de otro y en el orden en que ocurren.
 *
 * Cada fila dice su nombre, cómo va y cuánto ha tardado. Nada más: el
 * cronómetro corriendo de las etapas que aún no han empezado sólo servía para
 * llenar la pantalla de ceros.
 */
function StepList({ stages, locale }: { stages: StageState[]; locale: 'es' | 'en' }) {
    const es = locale === 'es';
    const now = Date.now();

    return (
        <ol className="space-y-1">
            {stages.map((s) => {
                const meta = STAGE_META[s.id];
                const Icon = meta.icon;
                const active = s.status === 'active' || s.status === 'waiting';
                const done = s.status === 'done';
                const error = s.status === 'error';
                const elapsed = s.startedAt ? (s.endedAt ?? now) - s.startedAt : 0;

                const estado = done ? (es ? 'Listo' : 'Done')
                    : error ? (es ? 'Falló' : 'Failed')
                        : s.status === 'waiting' ? (es ? 'Esperando' : 'Waiting')
                            : active ? (es ? 'En curso' : 'Running')
                                : (es ? 'Pendiente' : 'Pending');

                return (
                    <li
                        key={s.id}
                        className="rounded-lg px-3 py-2"
                        style={{
                            background: active ? 'var(--accent-subtle)' : 'transparent',
                            opacity: s.status === 'pending' ? 0.5 : 1,
                        }}
                    >
                        <div className="flex items-center gap-2 text-[12px]">
                            <span style={{ color: error ? '#ef4444' : done ? '#34d399' : active ? 'var(--accent)' : 'var(--text-muted)' }}>
                                {done ? <Check size={13} /> : error ? <AlertTriangle size={13} /> : active ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
                            </span>
                            <span className="font-medium" style={{ color: active || done ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                {meta[locale]}
                            </span>
                            <span className="ml-auto tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                {estado}
                            </span>
                            {s.startedAt && (
                                <span className="font-mono text-[10px] w-10 text-right" style={{ color: 'var(--text-muted)' }}>
                                    {formatClock(elapsed)}
                                </span>
                            )}
                        </div>

                        {active && s.detail && (
                            <p className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                                {s.detail}
                            </p>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

// ----------------------------------------------------------- los fragmentos

/**
 * Los fragmentos, con el tramo de grabación que cubre cada uno.
 *
 * El tablero anterior eran barritas numeradas del 1 al 12: para saber qué
 * trozo de la clase era el 7 había que multiplicar de cabeza. Aquí cada
 * fragmento dice su tramo ("20:00–30:00"), que es lo que el usuario reconoce.
 * Y ahora se llenan poco a poco, no de golpe: el porcentaje sale de los
 * timestamps que va emitiendo el modelo mientras transcribe.
 */
function ChunkGrid({ chunks, locale, selected, onSelect }: {
    chunks: ChunkState[];
    locale: 'es' | 'en';
    selected: number | null;
    onSelect: (index: number | null) => void;
}) {
    const es = locale === 'es';
    const done = chunks.filter((c) => c.status === 'done').length;
    const totalSec = chunks.reduce((sum, c) => sum + (c.endSec - c.startSec), 0);
    const doneSec = chunks.reduce((sum, c) => sum + (c.endSec - c.startSec) * c.progress, 0);

    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-[11px]">
                <span style={{ color: 'var(--text-secondary)' }}>
                    {es ? 'Fragmentos' : 'Chunks'}
                </span>
                <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {done}/{chunks.length}
                    {totalSec > 0 && ` · ${Math.round(doneSec / 60)}/${Math.round(totalSec / 60)} min`}
                </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                {chunks.map((c) => {
                    const isSelected = selected === c.index;
                    const color = c.status === 'error' ? '#ef4444'
                        : c.status === 'done' ? '#34d399'
                            : 'var(--accent)';
                    return (
                        <button
                            key={c.index}
                            onClick={() => onSelect(isSelected ? null : c.index)}
                            aria-pressed={isSelected}
                            aria-label={`${es ? 'Fragmento' : 'Chunk'} ${c.index + 1}`}
                            className={`relative overflow-hidden rounded-md px-2 py-1.5 text-left transition-all ${c.status === 'active' ? 'animate-pulse' : ''}`}
                            style={{
                                background: c.status === 'active' ? 'var(--accent-subtle)' : c.status === 'done' ? 'rgba(52, 211, 153, 0.1)' : 'var(--bg-tertiary)',
                                outline: isSelected ? '1.5px solid var(--accent)' : 'none',
                                outlineOffset: '1px',
                            }}
                        >
                            <span className="relative block text-[10px] font-mono leading-tight" style={{ color: 'var(--text-secondary)' }}>
                                {mmss(c.startSec)}–{mmss(c.endSec)}
                            </span>
                            <span className="relative block text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                {c.status === 'error'
                                    ? (es ? 'falló' : 'failed')
                                    : c.status === 'pending'
                                        ? (es ? 'en cola' : 'queued')
                                        : c.status === 'done'
                                            ? (es ? 'listo' : 'done')
                                            // El fragmento en curso lleva su avance: sale de los
                                            // timestamps que va emitiendo el modelo, así que es el
                                            // minuto de grabación por el que va de verdad. Sin él,
                                            // seis fragmentos "procesando" son seis cajas iguales.
                                            : `${es ? 'procesando' : 'processing'}${c.progress > 0 ? ` · ${Math.round(c.progress * 100)}%` : ''}`}
                            </span>
                        </button>
                    );
                })}
            </div>

            {selected !== null && chunks[selected] && (
                <ChunkNote chunk={chunks[selected]} locale={locale} />
            )}
        </div>
    );
}

/** Dos líneas sobre un fragmento. Lo demás ya está en el registro. */
function ChunkNote({ chunk, locale }: { chunk: ChunkState; locale: 'es' | 'en' }) {
    const es = locale === 'es';
    const estado = chunk.status === 'done' ? (es ? 'Completado' : 'Complete')
        : chunk.status === 'error' ? (es ? 'Falló' : 'Failed')
            : chunk.status === 'active' ? (es ? 'En curso' : 'In progress')
                : (es ? 'Pendiente' : 'Pending');

    const partes = [estado];
    if (chunk.model) partes.push(chunk.model);
    if (chunk.requests > 1) partes.push(es ? `${chunk.requests} intentos` : `${chunk.requests} attempts`);
    if (chunk.tokens > 0) partes.push(`${chunk.tokens.toLocaleString()} tokens`);

    return (
        <div
            className="rounded-md px-2.5 py-2 text-[11px] leading-relaxed"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
        >
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                {es ? 'Fragmento' : 'Chunk'} {chunk.index + 1}
            </span>
            {' · '}{mmss(chunk.startSec)}–{mmss(chunk.endSec)}
            <br />
            {partes.join(' · ')}
            {chunk.error && (
                <span style={{ color: '#ef4444' }}><br />{chunk.error}</span>
            )}
        </div>
    );
}

// ------------------------------------------------------------- la actividad

const EVENT_COLOR: Record<EventKind, string> = {
    error: '#ef4444',
    warn: '#eab308',
    retry: '#eab308',
    success: '#34d399',
    info: 'var(--text-secondary)',
};

/**
 * Registro de actividad.
 *
 * Un solo filtro —todo o sólo lo que fue mal— porque son las dos únicas
 * preguntas que alguien se hace mirando esto. El filtro por fragmento no
 * necesita botones propios: se filtra pulsando el fragmento de arriba.
 */
function ActivityLog({
    events, locale, open, onToggle, onlyIssues, onOnlyIssues, chunkFilter, onClearChunk,
}: {
    events: ActivityEvent[];
    locale: 'es' | 'en';
    open: boolean;
    onToggle: () => void;
    onlyIssues: boolean;
    onOnlyIssues: (v: boolean) => void;
    chunkFilter: number | null;
    onClearChunk: () => void;
}) {
    const es = locale === 'es';
    const isIssue = (e: ActivityEvent) => e.kind === 'warn' || e.kind === 'error' || e.kind === 'retry';
    const issues = events.filter(isIssue).length;

    const filtered = events.filter((e) =>
        (!onlyIssues || isIssue(e)) && (chunkFilter === null || e.chunk === chunkFilter));

    const hora = (at: number) => new Date(at).toLocaleTimeString(es ? 'es-ES' : 'en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    return (
        <div className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-3 py-2 text-[11px]"
                style={{ color: 'var(--text-secondary)' }}
                aria-expanded={open}
            >
                <span className="inline-flex items-center gap-1.5">
                    <Activity size={11} />
                    {es ? 'Actividad' : 'Activity'}
                    <span style={{ color: 'var(--text-muted)' }}>({events.length})</span>
                    {issues > 0 && (
                        <span className="px-1.5 rounded-full text-[9px] font-semibold"
                            style={{ background: 'rgba(234,179,8,0.15)', color: '#eab308' }}>
                            {issues}
                        </span>
                    )}
                </span>
                <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {!open ? (
                /* Cerrado se ve la última línea: siempre hay algo que leer. */
                <div className="px-3 pb-2 text-left">
                    {events.slice(-1).map((e) => (
                        <div key={e.id} className="flex gap-2 text-[11px]">
                            <span className="font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{hora(e.at)}</span>
                            <span className="truncate" style={{ color: EVENT_COLOR[e.kind] }}>{e.text}</span>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="px-3 pb-3 space-y-2 text-left">
                    <div className="flex flex-wrap items-center gap-1">
                        {([[false, es ? 'Todo' : 'All', events.length],
                           [true, es ? 'Avisos' : 'Issues', issues]] as const).map(([valor, etiqueta, cuenta]) => (
                            <button
                                key={String(valor)}
                                onClick={() => onOnlyIssues(valor)}
                                className="px-2 py-0.5 rounded-md border text-[10px] transition-colors"
                                style={{
                                    background: onlyIssues === valor ? 'var(--accent-subtle)' : 'transparent',
                                    borderColor: onlyIssues === valor ? 'var(--accent)' : 'var(--border-subtle)',
                                    color: onlyIssues === valor ? 'var(--accent)' : 'var(--text-muted)',
                                }}
                            >
                                {etiqueta} {cuenta}
                            </button>
                        ))}

                        {chunkFilter !== null && (
                            <button
                                onClick={onClearChunk}
                                className="px-2 py-0.5 rounded-md border text-[10px]"
                                style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                            >
                                {es ? `Sólo fragmento ${chunkFilter + 1} ✕` : `Chunk ${chunkFilter + 1} only ✕`}
                            </button>
                        )}
                    </div>

                    {filtered.length === 0 ? (
                        <p className="text-[11px] py-1" style={{ color: 'var(--text-muted)' }}>
                            {es ? 'Nada que mostrar con este filtro.' : 'Nothing matches this filter.'}
                        </p>
                    ) : (
                        <div className="space-y-0.5 max-h-52 overflow-y-auto custom-scrollbar">
                            {filtered.slice().reverse().map((e) => (
                                <div key={e.id} className="flex gap-2 text-[11px] leading-snug">
                                    <span className="font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                                        {hora(e.at)}
                                    </span>
                                    <span style={{ color: EVENT_COLOR[e.kind] }}>{e.text}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ------------------------------------------------------------------ textos

/**
 * Frase de estado en lenguaje corriente: qué hace el programa ahora mismo,
 * como se lo contarías a alguien.
 */
function headline(stage: StageId | null, locale: 'es' | 'en'): string {
    const es = locale === 'es';
    switch (stage) {
        case 'prepare': return es ? 'Preparando tu audio…' : 'Getting your audio ready…';
        case 'upload': return es ? 'Enviando el audio…' : 'Sending the audio…';
        case 'transcribe': return es ? 'Escuchando la grabación…' : 'Listening to the recording…';
        case 'organize': return es ? 'Escribiendo tus apuntes…' : 'Writing your notes…';
        default: return es ? 'Preparando todo…' : 'Getting everything ready…';
    }
}

/** Icono grande de la etapa: refuerza la frase sin añadir texto. */
const STAGE_ICON: Record<StageId, typeof Waves> = {
    prepare: Shrink,
    upload: Upload,
    transcribe: Waves,
    organize: FileText,
};



/**
 * Por qué la barra no se mueve.
 *
 * Un fragmento vale 15% al terminar de subirse y el resto lo va ganando con el
 * texto que devuelve el modelo. Cuando Google responde 503 a todo, TODOS los
 * fragmentos se quedan clavados exactamente en ese 15%, y desde fuera eso es
 * indistinguible de un cuelgue. Lo es tan poco que conviene decirlo: el audio
 * ya está allí, lo que falta es que el servicio conteste.
 */
function waitingForModel(chunks: ChunkState[]): boolean {
    const working = chunks.filter((c) => c.status === 'active' || c.status === 'pending');
    if (working.length === 0) return false;
    return chunks.every((c) => c.status === 'done' || c.progress <= 0.2);
}

/**
 * Lo que falta, en palabras.
 *
 * La ETA ya se calculaba (`snap.etaMs`) pero esta pantalla no la enseñaba, así
 * que lo único a la vista era un cronómetro subiendo — que dice cuánto llevas,
 * no cuánto queda. Aquí va redondeada y en palabras a propósito: un "quedan
 * ~137 s" es una precisión que la estimación no tiene, y cuando falla se nota.
 */
function friendlyEta(ms: number | null, locale: 'es' | 'en'): string {
    const es = locale === 'es';
    if (ms === null) return es ? 'Calculando lo que falta' : 'Estimating time left';
    if (ms < 20_000) return es ? 'Ya casi está' : 'Almost there';
    if (ms < 60_000) return es ? 'Menos de un minuto' : 'Less than a minute';
    const min = Math.round(ms / 60_000);
    if (min <= 1) return es ? 'Un minuto aproximadamente' : 'About a minute';
    return es ? `Unos ${min} minutos` : `About ${min} minutes`;
}

/**
 * Cuánta grabación lleva escuchada. Es el dato más concreto que se puede dar
 * sin hablar de fragmentos, modelos ni peticiones: minutos de SU clase.
 */
function listenedLine(doneSec: number, totalSec: number, locale: 'es' | 'en'): string | null {
    if (!(totalSec > 60) || doneSec <= 0) return null;
    const done = Math.floor(doneSec / 60);
    const total = Math.round(totalSec / 60);
    return locale === 'es'
        ? `${done} de ${total} minutos transcritos`
        : `${done} of ${total} minutes transcribed`;
}

export default function ProcessingView() {
    const locale = useAppStore((s) => s.locale);
    const file = useAppStore((s) => s.file);
    const snap = useProgress();
    const reduceMotion = useReducedMotion();

    // Todo lo técnico vive aquí dentro y arranca cerrado. Quien lo necesita
    // sabe buscarlo; a quien sólo quiere sus apuntes no le estorba.
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [logOpen, setLogOpen] = useState(false);
    const [onlyIssues, setOnlyIssues] = useState(false);
    const [selectedChunk, setSelectedChunk] = useState<number | null>(null);

    // Reloj propio: los contadores tienen que seguir corriendo aunque la red
    // no diga nada. Es la diferencia entre "trabajando" y "colgado".
    useTicker(1000);

    // Recarga con el proceso ya terminado: si las notas existen, esto no pinta.
    useEffect(() => {
        if (useAppStore.getState().organizedNotes) {
            useAppStore.getState().setStep('editor');
        }
    }, []);

    const es = locale === 'es';
    const now = Date.now();
    const failed = !!snap.error;
    const activeStage = snap.stages.find((s) => s.id === snap.activeStage);
    const pct = Number.isFinite(snap.global) ? Math.round(snap.global * 100) : 0;
    const elapsedTotal = snap.startedAt ? now - snap.startedAt : 0;
    const sinceBeat = now - snap.lastBeat;
    const stalled = !failed && sinceBeat > STALL_AFTER_MS && !snap.waitUntil;
    const waitLeft = snap.waitUntil ? Math.max(0, snap.waitUntil - now) : 0;

    const problema = failed ? friendlyError(snap.error, locale) : null;
    const esperandoModelo = !failed && snap.activeStage === 'transcribe' && waitingForModel(snap.chunks);
    const Icono = activeStage ? STAGE_ICON[activeStage.id] : Waves;
    const escuchado = listenedLine(snap.counters.audioDoneSec, snap.counters.audioTotalSec, locale);

    const detalles = (
        <div className="space-y-3 pt-3">
            <StepList stages={snap.stages} locale={locale} />

            {snap.chunks.length > 1 && (
                <ChunkGrid
                    chunks={snap.chunks}
                    locale={locale}
                    selected={selectedChunk}
                    onSelect={(i) => { setSelectedChunk(i); if (i !== null) setLogOpen(true); }}
                />
            )}

            {snap.events.length > 0 && (
                <ActivityLog
                    events={snap.events}
                    locale={locale}
                    open={logOpen}
                    onToggle={() => setLogOpen((v) => !v)}
                    onlyIssues={onlyIssues}
                    onOnlyIssues={setOnlyIssues}
                    chunkFilter={selectedChunk}
                    onClearChunk={() => setSelectedChunk(null)}
                />
            )}

            <p className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {formatClock(elapsedTotal)}
                {snap.model && ` · ${snap.model}`}
                {file && ` · ${file.name}`}
            </p>
        </div>
    );

    const botonDetalles = (
        <button
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className="inline-flex items-center gap-1 text-[11px] transition-colors hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
        >
            {es ? 'Ver detalles' : 'Show details'}
            <ChevronDown size={12} className={`transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
        </button>
    );

    // ---------------------------------------------------------------- fallo
    if (problema) {
        return (
            <div className="w-full max-w-lg mx-auto text-center space-y-5">
                <div className="flex flex-col items-center gap-3">
                    <div
                        className="w-14 h-14 rounded-2xl flex items-center justify-center"
                        style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}
                    >
                        <AlertTriangle size={26} />
                    </div>
                    <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                        {problema.title}
                    </h2>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }} aria-live="polite">
                        {problema.message}
                    </p>
                </div>

                <div className="flex items-center justify-center gap-2">
                    {problema.retryable && (
                        <button
                            onClick={() => useAppStore.getState().retryProcessing()}
                            className="inline-flex items-center gap-1.5 text-sm font-medium py-2 px-4 rounded-lg text-white transition-opacity hover:opacity-90"
                            style={{ background: 'var(--accent)' }}
                        >
                            <RotateCw size={14} />
                            {es ? 'Reintentar' : 'Try again'}
                        </button>
                    )}
                    <button
                        onClick={() => useAppStore.getState().reset()}
                        className="text-sm font-medium py-2 px-4 rounded-lg border transition-colors"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    >
                        {es ? 'Volver' : 'Go back'}
                    </button>
                </div>

                <div className="text-left">
                    {botonDetalles}
                    {detailsOpen && detalles}
                </div>
            </div>
        );
    }

    // -------------------------------------------------------------- en curso
    return (
        <div className="w-full max-w-lg mx-auto text-center space-y-6">
            <div className="flex flex-col items-center gap-4">
                <div
                    className="w-16 h-16 rounded-2xl flex items-center justify-center"
                    style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                >
                    {reduceMotion ? (
                        <Icono size={28} />
                    ) : (
                        <motion.div
                            animate={{ scale: [1, 1.08, 1] }}
                            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                        >
                            <Icono size={28} />
                        </motion.div>
                    )}
                </div>

                <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                    {headline(snap.activeStage, locale)}
                </h2>
            </div>

            {/* Indicador de carga indefinido */}
            <div className="space-y-3">
                <div className="flex justify-center mt-2 mb-2">
                    <Loader2 className="animate-spin" size={26} style={{ color: 'var(--accent)' }} />
                </div>
                <div className="text-sm flex items-center justify-center gap-2" style={{ color: 'var(--text-secondary)' }} aria-live="polite">
                    <span className="font-mono tabular-nums font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {formatClock(elapsedTotal)}
                    </span>
                    <span style={{ color: 'var(--border-default)' }}>·</span>
                    <span>
                        {esperandoModelo 
                            ? (es ? 'Esperando respuesta...' : 'Waiting for response...')
                            : activeStage?.id === 'transcribe' 
                                ? (es ? 'Recibiendo respuesta...' : 'Receiving response...')
                                : (es ? 'Procesando...' : 'Processing...')}
                    </span>
                </div>
                {escuchado && (
                    <p className="text-xs tabular-nums mt-1" style={{ color: 'var(--text-muted)' }}>{escuchado}</p>
                )}
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }} aria-live="polite">
                    {friendlyEta(snap.etaMs, locale)}
                </p>
            </div>

            {/* Espera deliberada y silencio: explicados, no disimulados */}
            <AnimatePresence>
                {waitLeft > 0 && (
                    <motion.p
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="text-xs leading-relaxed px-3"
                        style={{ color: '#eab308' }}
                    >
                        {es
                            ? `Hay mucha gente usando el servicio. Continuamos en ${Math.ceil(waitLeft / 1000)} s.`
                            : `The service is busy right now. Resuming in ${Math.ceil(waitLeft / 1000)}s.`}
                    </motion.p>
                )}
                {esperandoModelo && waitLeft === 0 && (
                    <motion.p
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="text-xs leading-relaxed px-3"
                        style={{ color: 'var(--text-muted)' }}
                    >
                        {es
                            ? 'Tu audio ya está subido. Esperando a que Gemini empiece a transcribir.'
                            : 'Your audio is uploaded. Waiting for Gemini to start transcribing.'}
                    </motion.p>
                )}
                {stalled && waitLeft === 0 && !esperandoModelo && (
                    <motion.p
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="text-xs leading-relaxed px-3"
                        style={{ color: 'var(--text-muted)' }}
                    >
                        {es
                            ? 'Sigue trabajando. Con grabaciones largas esto puede tardar un rato.'
                            : 'Still working. With long recordings this can take a while.'}
                    </motion.p>
                )}
            </AnimatePresence>

            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {es
                    ? 'Puedes dejar esta pestaña abierta en segundo plano.'
                    : 'You can leave this tab open in the background.'}
            </p>

            <div className="text-left">
                <div className="flex items-center justify-between gap-3 pt-1">
                    {botonDetalles}
                    <button
                        onClick={() => useAppStore.getState().cancelProcessing()}
                        className="shrink-0 text-xs font-medium py-1.5 px-3 rounded-lg transition-all border border-red-500/20 hover:border-red-500/40 hover:bg-red-500/10 text-red-500/80 hover:text-red-500"
                    >
                        {t('app.processing.cancel', locale as any)}
                    </button>
                </div>
                {detailsOpen && detalles}
            </div>
        </div>
    );
}

// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('framer-motion', () => ({
    AnimatePresence: ({ children }: any) => children,
    useReducedMotion: () => true,
    motion: new Proxy({}, {
        get: (_t, tag: string) => ({ children, initial, animate, exit, transition, ...props }: any) =>
            React.createElement(tag, props, children),
    }),
}));

import HistoryPanel from '../../src/components/react/HistoryPanel';
import { useAppStore } from '../../src/lib/store';
import { db, createProject, saveAudioSource, updateProjectState } from '../../src/lib/db';

/**
 * La pantalla "Ver archivos".
 *
 * Lo que importa que se vea: qué hay guardado, cuánto ocupa, y si a una entrada
 * le faltan los apuntes — porque de eso depende que "Abrir apuntes" se pueda
 * pulsar o no. Abrir una entrada a la que le falta el texto llevaría al editor
 * a enseñar una página en blanco.
 */

async function seed(title: string, opts: { notes?: string; transcription?: string } = {}) {
    const id = await createProject(title);
    await saveAudioSource(id, new File([new Uint8Array(1024 * 1024)], `${title}.m4a`, { type: 'audio/mp4' }));
    await updateProjectState(id, {
        step: 'editor',
        subStep: 'done',
        progress: 1,
        transcription: opts.transcription ?? '',
        organizedNotes: opts.notes ?? '',
        metadata: { provider: 'groq', durationMinutes: '42.0' },
    });
    await db.projects.update(id, { status: 'done', title });
    return id;
}

describe('panel de historial', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        await db.projects.clear();
        await db.audioSource.clear();
        await db.processingState.clear();
        // jsdom dice navigator.language = en-US; los textos comprobados son los españoles.
        useAppStore.setState({ locale: 'es', historyOpen: true, currentProjectId: null });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    /** Monta el panel y deja que resuelva la lectura de IndexedDB. */
    const render = async () => {
        await act(async () => { root.render(React.createElement(HistoryPanel)); });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    };

    it('sin nada guardado, lo dice en vez de enseñar una lista vacía', async () => {
        await render();
        expect(container.textContent).toContain('Todavía no hay nada guardado');
    });

    it('lista lo guardado con su archivo, su duración y su recuento', async () => {
        await seed('Criptografía', { notes: 'Uno dos tres', transcription: '[00:00] hola' });
        await render();

        expect(container.textContent).toContain('Criptografía');
        expect(container.textContent).toContain('Criptografía.m4a');
        expect(container.textContent).toContain('3 palabras');
        expect(container.textContent).toContain('42.0 min');
        expect(container.textContent).toContain('Groq');
    });

    it('cuenta los archivos en la cabecera', async () => {
        await seed('Una', { notes: 'x' });
        await seed('Otra', { notes: 'y' });
        await render();

        expect(container.textContent).toContain('2 archivos');
    });

    /**
     * jsdom + fake-indexeddb devuelven el Blob sin `size`, que es justo el caso
     * que antes pintaba "NaN KB" en la fila. Los tamaños de verdad se
     * comprueban en `tests/unit/history.test.ts`, sobre la base real; lo que se
     * exige aquí es que un tamaño desconocido se calle en vez de mentir.
     */
    it('nunca enseña NaN cuando no se sabe el tamaño del audio', async () => {
        await seed('Sin tamaño', { notes: 'x' });
        await render();

        expect(container.textContent).toContain('Sin tamaño.m4a');
        expect(container.textContent).not.toContain('NaN');
    });

    it('sin apuntes, "Abrir apuntes" queda deshabilitado y se avisa por qué', async () => {
        await seed('Se cortó', { transcription: '[00:00] esto sí se transcribió' });
        await render();

        expect(container.textContent).toContain('Sin apuntes generados');

        const abrir = [...container.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('Abrir apuntes')) as HTMLButtonElement;
        expect(abrir).toBeTruthy();
        // Abrirlo llevaría al editor a enseñar una página en blanco.
        expect(abrir.disabled).toBe(true);

        // La transcripción sí está, así que ese botón sigue vivo.
        const verTrans = [...container.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('Transcripción')) as HTMLButtonElement;
        expect(verTrans.disabled).toBe(false);
    });

    it('abrir una entrada carga sus apuntes en el editor y cierra el panel', async () => {
        const id = await seed('Álgebra', { notes: '# Álgebra\ncontenido', transcription: '[00:00] hola' });
        await render();

        const abrir = [...container.querySelectorAll('button')]
            .find((b) => b.textContent?.includes('Abrir apuntes')) as HTMLButtonElement;

        await act(async () => { abrir.click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

        const state = useAppStore.getState();
        expect(state.currentProjectId).toBe(id);
        expect(state.organizedNotes).toBe('# Álgebra\ncontenido');
        expect(state.editedNotes).toBe('# Álgebra\ncontenido');
        expect(state.transcription).toBe('[00:00] hola');
        expect(state.step).toBe('editor');
        expect(state.historyOpen).toBe(false);
        // El audio vuelve como File para que el reproductor del editor funcione.
        expect(state.file?.name).toBe('Álgebra.m4a');
    });

    it('borrar pide confirmación antes de llevarse nada', async () => {
        await seed('A borrar', { notes: 'x' });
        await render();

        const papelera = [...container.querySelectorAll('button')]
            .find((b) => b.getAttribute('aria-label') === 'Eliminar') as HTMLButtonElement;

        await act(async () => { papelera.click(); });
        expect(container.textContent).toContain('¿Eliminar definitivamente?');
        // Nada se ha borrado todavía: sólo se ha preguntado.
        expect(await db.projects.count()).toBe(1);

        const confirmar = [...container.querySelectorAll('button')]
            .find((b) => b.textContent === 'Sí, eliminar') as HTMLButtonElement;
        await act(async () => { confirmar.click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

        expect(await db.projects.count()).toBe(0);
        expect(await db.audioSource.count()).toBe(0);
        expect(container.textContent).toContain('Todavía no hay nada guardado');
    });
});

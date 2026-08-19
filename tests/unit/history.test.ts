import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    db, createProject, saveAudioSource, updateProjectState,
    listHistory, loadProject, loadProjectAudio, deleteProject, touchProject,
} from '../../src/lib/db';

/**
 * El historial ("Ver archivos").
 *
 * La base de datos ya guardaba cada clase con su audio, su transcripción y sus
 * apuntes, pero la interfaz sólo sabía enseñar la última: lo anterior ocupaba
 * disco sin forma de volver a ello ni de borrarlo. Lo que se prueba aquí es que
 * la lista dice la verdad sobre lo guardado y que borrar borra de veras — que
 * es lo único de esta pantalla que no tiene vuelta atrás.
 */

const audio = (name = 'clase.m4a', bytes = 2048) =>
    new File([new Uint8Array(bytes)], name, { type: 'audio/mp4' });

/** Crea un proyecto terminado, con audio, transcripción y apuntes. */
async function seedProject(opts: {
    title: string;
    transcription?: string;
    notes?: string;
    withAudio?: boolean;
    status?: 'done' | 'error' | 'processing';
} ) {
    const id = await createProject(opts.title);
    if (opts.withAudio !== false) await saveAudioSource(id, audio(`${opts.title}.m4a`));
    await updateProjectState(id, {
        step: 'editor',
        subStep: 'done',
        progress: 1,
        transcription: opts.transcription ?? '',
        organizedNotes: opts.notes ?? '',
        metadata: { provider: 'groq', durationMinutes: '42.0' },
    });
    await db.projects.update(id, { status: opts.status ?? 'done', title: opts.title });
    return id;
}

describe('historial de apuntes guardados', () => {
    beforeEach(async () => {
        await db.projects.clear();
        await db.audioSource.clear();
        await db.processingState.clear();
    });

    it('lista vacía cuando no hay nada guardado', async () => {
        expect(await listHistory()).toEqual([]);
    });

    it('devuelve lo más reciente primero', async () => {
        const viejo = await seedProject({ title: 'Primera' });
        // `updatedAt` se toma del reloj: sin separarlos, el orden queda al azar.
        await db.projects.update(viejo, { updatedAt: Date.now() - 60_000 });
        await seedProject({ title: 'Segunda' });

        const historial = await listHistory();
        expect(historial.map((e) => e.title)).toEqual(['Segunda', 'Primera']);
    });

    it('resume cada entrada sin arrastrar el audio ni los textos completos', async () => {
        await seedProject({
            title: 'Criptografía',
            transcription: '[00:00] hola qué tal',
            notes: 'Unas notas de cinco palabras exactamente',
        });

        const [entrada] = await listHistory();

        expect(entrada.title).toBe('Criptografía');
        expect(entrada.status).toBe('done');
        expect(entrada.hasTranscription).toBe(true);
        expect(entrada.hasNotes).toBe(true);
        expect(entrada.noteWords).toBe(6);
        expect(entrada.transcriptChars).toBe('[00:00] hola qué tal'.length);
        expect(entrada.provider).toBe('groq');
        expect(entrada.durationMinutes).toBe('42.0');

        // Del audio sólo viajan los metadatos: el Blob se queda en la base.
        expect(entrada.audio).toEqual({ name: 'Criptografía.m4a', type: 'audio/mp4', size: 2048 });
        expect(entrada).not.toHaveProperty('file');
    });

    it('un proceso que murió a medias se lista, y se ve que le faltan los apuntes', async () => {
        await seedProject({
            title: 'Se cortó',
            transcription: '[00:00] esto sí se transcribió',
            notes: '',
            status: 'error',
        });

        const [entrada] = await listHistory();
        expect(entrada.status).toBe('error');
        expect(entrada.hasTranscription).toBe(true);
        // Lo que decide si el botón "Abrir apuntes" se puede pulsar.
        expect(entrada.hasNotes).toBe(false);
        expect(entrada.noteWords).toBe(0);
    });

    it('un proyecto sin audio no rompe la lista', async () => {
        await seedProject({ title: 'Sin audio', withAudio: false, notes: 'algo' });
        const [entrada] = await listHistory();
        expect(entrada.audio).toBeNull();
    });

    describe('abrir una entrada', () => {
        it('rehidrata el audio como File y devuelve los textos', async () => {
            const id = await seedProject({
                title: 'Álgebra',
                transcription: '[00:00] transcripción',
                notes: '# Álgebra\ncontenido',
            });

            const data = await loadProject(id);
            expect(data).not.toBeNull();
            expect(data!.transcription).toBe('[00:00] transcripción');
            expect(data!.organizedNotes).toBe('# Álgebra\ncontenido');
            expect(data!.file).toBeInstanceOf(File);
            expect(data!.file!.name).toBe('Álgebra.m4a');
            expect(data!.file!.type).toBe('audio/mp4');
        });

        it('devuelve null si el proyecto ya no existe', async () => {
            expect(await loadProject(9999)).toBeNull();
        });

        it('el audio se puede pedir solo, sin cargar los textos', async () => {
            const id = await seedProject({ title: 'Química' });
            const file = await loadProjectAudio(id);
            expect(file?.name).toBe('Química.m4a');
            expect(file?.size).toBe(2048);
        });

        it('marcarlo como usado lo pone el primero de la lista', async () => {
            const primero = await seedProject({ title: 'Vieja' });
            await db.projects.update(primero, { updatedAt: Date.now() - 60_000 });
            await seedProject({ title: 'Nueva' });

            await touchProject(primero);

            // Importa porque `restoreSession` recupera el proyecto tocado más
            // recientemente: si abrir del historial no lo tocara, al recargar
            // volvería otro proyecto distinto del que se está mirando.
            expect((await listHistory())[0].title).toBe('Vieja');
        });
    });

    describe('borrar', () => {
        it('se lleva el audio y el estado, no sólo la fila del proyecto', async () => {
            const id = await seedProject({ title: 'A borrar', transcription: 'x', notes: 'y' });

            await deleteProject(id);

            expect(await listHistory()).toEqual([]);
            expect(await db.projects.get(id)).toBeUndefined();
            // Lo que de verdad ocupaba disco: si esto sobrevive, el usuario no
            // tiene ninguna forma de recuperar ese espacio desde la interfaz.
            expect(await db.audioSource.where({ projectId: id }).count()).toBe(0);
            expect(await db.processingState.where({ projectId: id }).count()).toBe(0);
        });

        it('no toca a los demás', async () => {
            const uno = await seedProject({ title: 'Uno' });
            await seedProject({ title: 'Dos' });

            await deleteProject(uno);

            const historial = await listHistory();
            expect(historial).toHaveLength(1);
            expect(historial[0].title).toBe('Dos');
            expect(await db.audioSource.count()).toBe(1);
        });

        it('borrar algo que ya no está no revienta', async () => {
            await expect(deleteProject(9999)).resolves.toBeUndefined();
        });
    });
});

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

/**
 * Módulo de Chunking Temporal con FFmpeg.wasm
 * Corta archivos de audio/video por TIEMPO (no bytes) para preservar estructura
 * Soporta: M4A, MP4, MKV, WEBM, OPUS, FLAC, WAV, etc.
 */

/** Plazo para descargar e inicializar el core de FFmpeg.wasm (~30 MB). */
const LOAD_TIMEOUT_MS = 120_000;
/** Plazo para una sola orden de FFmpeg. */
const EXEC_TIMEOUT_MS = 600_000;
/** Plazo para leer sólo las cabeceras de un archivo. */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Pone plazo a una promesa que no lo trae.
 *
 * FFmpeg.wasm no ofrece cancelación: si el WASM se atasca, la promesa nunca
 * resuelve. Al menos se deja de esperar y se puede degradar a otra ruta.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${message} (${Math.round(ms / 1000)}s)`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

let ffmpegInstance: FFmpeg | null = null;
let isLoaded = false;

/**
 * Cargar FFmpeg.wasm (primera vez descarga ~30MB, luego cachea)
 */
async function loadFFmpeg(onProgress?: (message: string, ratio: number) => void): Promise<FFmpeg> {
    if (ffmpegInstance && isLoaded) {
        return ffmpegInstance;
    }

    if (!ffmpegInstance) {
        ffmpegInstance = new FFmpeg();
    }

    if (!isLoaded) {
        onProgress?.('Cargando FFmpeg.wasm...', 0);

        // Configurar logging
        ffmpegInstance.on('log', ({ message }) => {
            console.log('[FFmpeg]', message);
        });

        // Configurar progreso
        ffmpegInstance.on('progress', ({ progress, time }) => {
            onProgress?.(`Procesando... ${Math.round(progress * 100)}%`, progress);
        });

        // Cargar WASM localmente (evita problemas de COEP con CDNs externos)
        const baseURL = window.location.origin + '/ffmpeg';

        // El core pesa ~30 MB: si la descarga se queda a medias, sin plazo esto
        // no vuelve nunca y el usuario ve "Cargando el motor de audio" para
        // siempre. Con plazo, la capa de arriba cae al camino sin FFmpeg.
        await withTimeout(
            ffmpegInstance.load({
                coreURL: `${baseURL}/ffmpeg-core.js`,
                wasmURL: `${baseURL}/ffmpeg-core.wasm`,
            }),
            LOAD_TIMEOUT_MS,
            'No se pudo cargar el motor de audio (FFmpeg)',
        );

        isLoaded = true;
        onProgress?.('FFmpeg cargado', 1);
    }

    return ffmpegInstance;
}

/**
 * Información de un chunk generado
 */
export interface ChunkInfo {
    file: File;
    startTime: number;  // segundos
    endTime: number;    // segundos
    index: number;
}

/**
 * Resultado del chunking temporal
 */
export interface TemporalChunkingResult {
    chunks: ChunkInfo[];
    totalDuration: number;
    format: string;
}

/**
 * Determinar extensión de salida según tipo MIME
 */
function getOutputExtension(mimeType: string, fileName: string): string {
    // Priorizar extensión del archivo
    const fileExt = fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase();

    if (fileExt && ['m4a', 'mp4', 'webm', 'opus', 'flac', 'wav', 'ogg'].includes(fileExt)) {
        return fileExt;
    }

    // Fallback por MIME type
    const mimeMap: Record<string, string> = {
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/m4a': 'm4a',
        'audio/aac': 'm4a',
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/webm': 'webm',
        'audio/opus': 'opus',
        'audio/ogg': 'ogg',
        'audio/flac': 'flac',
        'audio/wav': 'wav',
        'video/mp4': 'mp4',
        'video/quicktime': 'mp4',
        'video/webm': 'webm',
    };

    return mimeMap[mimeType] || 'm4a';
}

/**
 * Determinar codec de salida para -c copy
 * Algunos formatos necesitan recodificación ligera
 */
function needsReencoding(extension: string): boolean {
    // Estos formatos suelen tener problemas con -c copy en segmentos temporales directos
    // Quitamos 'flac' de aquí porque soporta stream copy perfectamente bien.
    const problematicFormats = ['opus', 'avi'];
    return problematicFormats.includes(extension);
}

/**
 * Chunking temporal de archivo de audio/video
 * 
 * @param file Archivo original (M4A, MP4, WEBM, etc.)
 * @param totalDuration Duración total del archivo en segundos (obtenida con Web Audio API)
 * @param chunkDurationMinutes Duración de cada chunk en minutos (default: 20)
 * @param overlapSeconds Overlap entre chunks para evitar cortes de palabras (default: 30)
 * @param onProgress Callback de progreso
 * @returns Array de chunks con metadata
 */
export async function chunkFileTemporally(
    file: File,
    totalDuration: number,
    chunkDurationMinutes: number = 20,
    overlapSeconds: number = 30,
    onProgress?: (stage: string, progress: number) => void
): Promise<TemporalChunkingResult> {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[FFmpeg Chunker] 🎬 Starting Temporal Chunking');
    console.log(`[FFmpeg Chunker] File: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log(`[FFmpeg Chunker] Chunk size: ${chunkDurationMinutes} min`);
    console.log(`[FFmpeg Chunker] Overlap: ${overlapSeconds}s`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (totalDuration <= 0) {
        throw new Error('Invalid duration provided');
    }

    const startTime = Date.now();

    // 1. Cargar FFmpeg
    const ffmpeg = await loadFFmpeg((msg, ratio) => {
        onProgress?.(`loading`, ratio * 0.1); // 0-10%
    });

    // 2. Escribir archivo en sistema virtual de FFmpeg
    onProgress?.('preparing', 0.1);
    const inputFileName = 'input.' + getOutputExtension(file.type, file.name);
    await ffmpeg.writeFile(inputFileName, await fetchFile(file));

    // 3. Usar duración provista
    onProgress?.('chunking', 0.15);

    // SAFETY CHECK: If duration is Infinity or NaN, we can't chunk temporally.
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
        console.warn('[FFmpeg Chunker] ⚠️ Invalid duration (Infinity/NaN). Falling back to direct pass.');
        // Cleanup and exit early with a single chunk
        await ffmpeg.deleteFile(inputFileName);
        const chunkBlob = new Blob([await file.arrayBuffer()], { type: file.type });
        const singleFile = new File([chunkBlob], file.name, { type: file.type });
        return {
            chunks: [{ file: singleFile, startTime: 0, endTime: 0, index: 0 }],
            totalDuration: 0,
            format: getOutputExtension(file.type, file.name)
        };
    }

    const duration = totalDuration;
    const durationMinutes = duration / 60;
    console.log(`[FFmpeg Chunker] Total duration: ${durationMinutes.toFixed(1)} min (${duration.toFixed(1)}s)`);

    // 4. Calcular chunks
    const chunkDurationSeconds = chunkDurationMinutes * 60;
    const chunks: ChunkInfo[] = [];
    const extension = getOutputExtension(file.type, file.name);
    let finalExtension = extension;
    let finalMime = file.type;

    const shouldReencode = needsReencoding(extension);

    // Si recodificamos, forzamos formato universal AAC/M4A
    if (shouldReencode) {
        finalExtension = 'm4a';
        finalMime = 'audio/mp4';
    }

    let currentTime = 0;
    let chunkIndex = 0;
    const MAX_CHUNKS = 100; // Hard limit to prevent infinite loops

    while (currentTime < duration && chunkIndex < MAX_CHUNKS) {
        const startSeconds = currentTime;
        const endSeconds = Math.min(currentTime + chunkDurationSeconds + overlapSeconds, duration);
        const chunkDuration = endSeconds - startSeconds;

        const outputFileName = `chunk_${chunkIndex}.${finalExtension}`;

        // Progreso: 15% + (chunk actual / total chunks) * 80%
        const estimatedChunks = Math.ceil(duration / chunkDurationSeconds);
        const chunkProgress = chunkIndex / estimatedChunks;
        onProgress?.('chunking', 0.15 + (chunkProgress * 0.8));

        console.log(`[FFmpeg Chunker] ✂️  Chunk ${chunkIndex + 1}: ${(startSeconds / 60).toFixed(1)}-${(endSeconds / 60).toFixed(1)} min`);

        // FFmpeg command
        let exitCode: number;
        if (shouldReencode) {
            // Recodificación ligera para formatos problemáticos
            exitCode = await withTimeout(ffmpeg.exec([
                '-i', inputFileName,
                '-ss', startSeconds.toString(),
                '-t', chunkDuration.toString(),
                '-c:a', 'aac',        // Codec universal
                '-b:a', '128k',       // Calidad decente
                '-y',
                outputFileName
            ]), EXEC_TIMEOUT_MS, 'FFmpeg tardó demasiado troceando el audio');
        } else {
            // Stream copy (super rápido, sin recodificación)
            exitCode = await withTimeout(ffmpeg.exec([
                '-i', inputFileName,
                '-ss', startSeconds.toString(),
                '-t', chunkDuration.toString(),
                '-c', 'copy',         // No recodificar
                '-y',
                outputFileName
            ]), EXEC_TIMEOUT_MS, 'FFmpeg tardó demasiado troceando el audio');
        }

        if (exitCode !== 0) {
            throw new Error(`FFmpeg failed with exit code ${exitCode} while processing chunk ${chunkIndex}`);
        }

        // Leer chunk generado
        const chunkData = await ffmpeg.readFile(outputFileName);

        // CORRECCIÓN CRÍTICA: FFmpeg usa SharedArrayBuffer, que Blob no acepta directamente en algunos contextos
        // Hacemos una copia profunda a un ArrayBuffer estándar
        const dataArray = chunkData as Uint8Array;
        const standardBuffer = new Uint8Array(dataArray.length);
        standardBuffer.set(dataArray);

        const chunkBlob = new Blob([standardBuffer], { type: finalMime });
        const chunkFile = new File(
            [chunkBlob],
            `${file.name.replace(/\.[^.]+$/, '')}_part${chunkIndex}.${finalExtension}`,
            { type: finalMime }
        );

        chunks.push({
            file: chunkFile,
            startTime: startSeconds,
            endTime: endSeconds,
            index: chunkIndex
        });

        console.log(`[FFmpeg Chunker]    Size: ${(chunkFile.size / 1024 / 1024).toFixed(1)}MB`);

        // Limpiar archivo temporal
        await ffmpeg.deleteFile(outputFileName);

        currentTime += chunkDurationSeconds;
        chunkIndex++;
    }

    // 5. Limpiar archivo original
    await ffmpeg.deleteFile(inputFileName).catch(() => { /* ya no estaba */ });

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[FFmpeg Chunker] ✅ Chunking Complete');
    console.log(`[FFmpeg Chunker] Time: ${totalTime}s`);
    console.log(`[FFmpeg Chunker] Created ${chunks.length} chunks`);
    console.log(`[FFmpeg Chunker] Strategy: ${shouldReencode ? 'Re-encode (AAC)' : 'Stream Copy'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    onProgress?.('done', 1);

    return {
        chunks,
        totalDuration: duration,
        format: extension
    };
}

/**
 * Recorta un trozo de un audio ya existente, por tiempo.
 *
 * Lo pide la recuperación de bucles: cuando un modelo se queda atascado
 * repitiendo, lo transcrito ANTES del atasco sirve, y lo único que hay que
 * volver a pedir es el audio que va desde ese segundo hasta el final del
 * fragmento. Esto lo corta.
 *
 * Es el mismo `-c copy` que usa el troceado: no se recodifica nada, así que un
 * recorte cuesta milisegundos y no toca la calidad. El corte cae en el paquete
 * más cercano —décimas de segundo— y eso da igual: el trozo se vuelve a
 * transcribir entero desde su marca de tiempo.
 *
 * @param startSec Segundo del archivo original donde empieza el recorte.
 * @param endSec   Segundo donde acaba. Sin él, hasta el final.
 */
export async function sliceAudio(file: File, startSec: number, endSec?: number): Promise<File> {
    if (!(startSec >= 0)) throw new Error('sliceAudio: inicio inválido');

    const ffmpeg = await loadFFmpeg();
    const extension = getOutputExtension(file.type, file.name);
    const reencode = needsReencoding(extension);
    const outExtension = reencode ? 'm4a' : extension;
    const outMime = reencode ? 'audio/mp4' : (file.type || 'audio/mp4');

    const inputName = `slice_input.${extension}`;
    const outputName = `slice_output.${outExtension}`;

    try {
        await ffmpeg.writeFile(inputName, await fetchFile(file));

        const args = ['-i', inputName, '-ss', String(startSec)];
        if (endSec !== undefined && endSec > startSec) args.push('-t', String(endSec - startSec));
        args.push(...(reencode ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c', 'copy']), '-y', outputName);

        const exitCode = await withTimeout(
            ffmpeg.exec(args),
            EXEC_TIMEOUT_MS,
            'FFmpeg tardó demasiado recortando el audio',
        );
        if (exitCode !== 0) throw new Error(`FFmpeg terminó con código ${exitCode} al recortar el audio`);

        const data = await ffmpeg.readFile(outputName) as Uint8Array;
        // Copia a un ArrayBuffer normal: lo que devuelve FFmpeg vive en un
        // SharedArrayBuffer y `Blob` no siempre lo acepta.
        const copy = new Uint8Array(data.length);
        copy.set(data);

        const base = file.name.replace(/\.[^.]+$/, '');
        const outFile = new File(
            [new Blob([copy], { type: outMime })],
            `${base}_from${Math.round(startSec)}s.${outExtension}`,
            { type: outMime },
        );
        if (outFile.size === 0) throw new Error('El recorte salió vacío');
        return outFile;
    } finally {
        await ffmpeg.deleteFile(inputName).catch(() => { /* puede no haberse escrito */ });
        await ffmpeg.deleteFile(outputName).catch(() => { /* puede no haberse creado */ });
    }
}

/**
 * Lee la duración de un archivo sin decodificarlo entero.
 *
 * Es el último recurso cuando ni el elemento `<audio>` ni `decodeAudioData`
 * pueden con el archivo (contenedores raros, o archivos tan grandes que
 * decodificarlos en memoria mataría la pestaña). FFmpeg sólo lee las cabeceras.
 */
export async function probeDuration(file: File): Promise<number> {
    const ffmpeg = await loadFFmpeg();
    const inputName = 'probe_input.' + getOutputExtension(file.type, file.name);

    let seconds = 0;
    const onLog = ({ message }: { message: string }) => {
        // FFmpeg lo escupe por el log: "Duration: 00:48:12.34, start: ..."
        const m = message.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
        if (m) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    };
    ffmpeg.on('log', onLog);

    try {
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        // `-i` sin salida termina con error a propósito: sólo interesa el log.
        await withTimeout(ffmpeg.exec(['-i', inputName]), PROBE_TIMEOUT_MS, 'FFmpeg tardó demasiado leyendo la duración')
            .catch(() => { /* el código de salida da igual */ });
        return seconds;
    } finally {
        ffmpeg.off('log', onLog);
        await ffmpeg.deleteFile(inputName).catch(() => { /* puede no haberse escrito */ });
    }
}

/**
 * Extrae la pista de audio de un vídeo (o recodifica un audio) con FFmpeg.
 *
 * La ruta antigua decodificaba el archivo entero a PCM en memoria con la Web
 * Audio API: una clase de dos horas en vídeo son ~2,5 GB de Float32 y la
 * pestaña moría antes de llegar a transcribir nada. FFmpeg trabaja sobre su
 * propio sistema de archivos y no necesita el audio entero descomprimido en el
 * heap de JavaScript.
 *
 * Sale AAC en contenedor M4A porque el codificador `aac` va compilado en todos
 * los cores de FFmpeg.wasm; libmp3lame no siempre está.
 */
export async function extractAudioTrack(
    file: File,
    opts: { sampleRate: number; bitrateKbps: number },
    onProgress?: (progress: number) => void,
): Promise<{ file: File }> {
    const ffmpeg = await loadFFmpeg((_msg, ratio) => onProgress?.(ratio * 0.15));

    const inputName = 'extract_input.' + getOutputExtension(file.type, file.name);
    const outputName = 'extract_output.m4a';

    const onExecProgress = ({ progress: ratio }: { progress: number }) => {
        if (Number.isFinite(ratio)) onProgress?.(0.15 + Math.min(1, Math.max(0, ratio)) * 0.8);
    };
    ffmpeg.on('progress', onExecProgress);

    try {
        await ffmpeg.writeFile(inputName, await fetchFile(file));

        const exitCode = await withTimeout(ffmpeg.exec([
            '-i', inputName,
            '-vn',                                  // fuera el vídeo
            '-ac', '1',                             // mono: la voz no gana nada en estéreo
            '-ar', String(opts.sampleRate),
            '-c:a', 'aac',
            '-b:a', `${opts.bitrateKbps}k`,
            '-y',
            outputName,
        ]), EXEC_TIMEOUT_MS, 'FFmpeg tardó demasiado extrayendo el audio');

        if (exitCode !== 0) {
            throw new Error(`FFmpeg terminó con código ${exitCode} al extraer el audio`);
        }

        const data = await ffmpeg.readFile(outputName) as Uint8Array;
        const copy = new Uint8Array(data.length);
        copy.set(data);

        const outFile = new File(
            [new Blob([copy], { type: 'audio/mp4' })],
            file.name.replace(/\.[^.]+$/, '') + '_audio.m4a',
            { type: 'audio/mp4' },
        );

        onProgress?.(1);
        return { file: outFile };
    } finally {
        ffmpeg.off('progress', onExecProgress);
        await ffmpeg.deleteFile(inputName).catch(() => { /* puede no haberse escrito */ });
        await ffmpeg.deleteFile(outputName).catch(() => { /* puede no haberse creado */ });
    }
}

/**
 * Validar si FFmpeg.wasm está disponible en el navegador
 */
export function isFFmpegSupported(): boolean {
    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    const hasWebAssembly = typeof WebAssembly !== 'undefined';

    console.log('[FFmpeg Support Check]');
    console.log(' - SharedArrayBuffer:', hasSharedArrayBuffer ? '✅ OK' : '❌ MISSING (Blocked by Browser/Headers)');
    console.log(' - WebAssembly:', hasWebAssembly ? '✅ OK' : '❌ MISSING');

    // FFmpeg.wasm requiere SharedArrayBuffer y WASM
    return hasSharedArrayBuffer && hasWebAssembly;
}

import { Mp3Encoder } from '@breezystack/lamejs';
import { chunkFileTemporally, isFFmpegSupported, extractAudioTrack, probeDuration } from './ffmpeg-chunker';
import { sanitizeDuration } from './duration';
import { CHUNK_SIZE_MINUTES as GEMINI_CHUNK_MINUTES, CHUNK_OVERLAP_SECONDS as GEMINI_CHUNK_OVERLAP } from './gemini';

export { sanitizeDuration };


// Configuración por proveedor
const GROQ_SAMPLE_RATE = 16000;   // 16kHz - Óptimo para Whisper
const GROQ_BITRATE = 64;          // 64kbps - Suficiente para voz
const GROQ_MAX_SIZE = 25 * 1024 * 1024;    // 25MB - Límite Whisper API
const GROQ_CHUNK_SIZE = 20 * 1024 * 1024;  // 20MB por chunk

const GEMINI_SAMPLE_RATE = 44100; // 44.1kHz - Alta calidad
const GEMINI_BITRATE = 128;       // 128kbps - Alta calidad

/**
 * Umbral y tamaño del troceado, en minutos.
 *
 * Lo fija la capa de Gemini (`CHUNK_SIZE_MINUTES`) para que el corte físico del
 * audio y lo que después se le pide al modelo hablen del mismo tamaño. Estaban
 * duplicados en 20 en los dos sitios, así que cambiarlo en uno solo dejaba
 * fragmentos que no coincidían con los tiempos anunciados.
 */
const CHUNKING_THRESHOLD_MINUTES = GEMINI_CHUNK_MINUTES;

export interface CompressionResult {
    file: File;
    originalSize: number;
    compressedSize: number;
    ratio: number;
    duration: number; // Duración del audio resultante en segundos
}

export interface ProcessedAudio {
    chunks: File[];
    originalSize: number;
    compressedSize: number;
    wasCompressed: boolean;
    wasChunked: boolean;
    duration?: number; // Duración en segundos
    chunkingMethod?: 'temporal-ffmpeg' | 'binary' | 'none'; // Método de chunking usado
    chunkMetadata?: { startTime: number; endTime: number; index: number }[]; // Info de tiempos por chunk
}

/**
 * Plazo del elemento `<audio>`.
 *
 * Corto a propósito: en Chrome se ha observado que un `<audio>` con una URL de
 * blob puede quedarse en `networkState: LOADING` / `readyState: 0` para
 * siempre, sin emitir `loadedmetadata` NI `error`, incluso con un MP3
 * perfectamente válido. Esperar más no aporta nada; hay caminos mejores debajo.
 */
const ELEMENT_TIMEOUT_MS = 8_000;

/**
 * Tope para leer la duración decodificando.
 *
 * `decodeAudioData` es exacto y rapidísimo, pero deja el audio entero en
 * memoria: por encima de este tamaño se pasa a FFmpeg, que sólo lee cabeceras.
 */
const MAX_DECODE_PROBE_BYTES = 15 * 1024 * 1024;

/** Duración según el elemento multimedia, o 0 si no contesta a tiempo. */
function durationFromElement(file: File): Promise<number> {
    return new Promise<number>((resolve) => {
        const url = URL.createObjectURL(file);
        const media = file.type.startsWith('video/')
            ? document.createElement('video')
            : document.createElement('audio');

        let settled = false;
        const finish = (duration: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            media.onloadedmetadata = null;
            media.onerror = null;
            try { media.src = ''; } catch { /* el navegador ya lo soltó */ }
            URL.revokeObjectURL(url);
            resolve(sanitizeDuration(duration));
        };

        const timer = setTimeout(() => finish(0), ELEMENT_TIMEOUT_MS);
        media.onloadedmetadata = () => finish(media.duration);
        media.onerror = () => finish(0);
        media.src = url;
    });
}

/** Duración exacta decodificando el audio. Sólo para archivos manejables. */
async function durationFromDecode(file: File): Promise<number> {
    if (file.size > MAX_DECODE_PROBE_BYTES) return 0;
    let ctx: AudioContext | null = null;
    try {
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
        return sanitizeDuration(buffer.duration);
    } catch {
        return 0;
    } finally {
        await ctx?.close().catch(() => { /* ya cerrado */ });
    }
}

/** Duración leyendo sólo las cabeceras con FFmpeg. */
async function durationFromFFmpeg(file: File): Promise<number> {
    if (!isFFmpegSupported()) return 0;
    try {
        return sanitizeDuration(await probeDuration(file));
    } catch (e: any) {
        console.warn('[AudioProcessor] FFmpeg no pudo leer la duración:', e?.message || e);
        return 0;
    }
}

/**
 * Obtener la duración de un archivo multimedia, por tres caminos.
 *
 * Se probó con un solo camino —el elemento `<audio>`— y resultó ser el menos
 * fiable de los tres: en Chrome se queda cargando indefinidamente con archivos
 * válidos, y como no emite `error` tampoco había forma de enterarse. Eso
 * bloqueaba el proceso ANTES de la primera petición, con cualquier archivo.
 *
 * Devuelve 0 si ninguno lo consigue — nunca `Infinity` ni `NaN`, y nunca se
 * queda esperando.
 */
export async function getMediaDuration(file: File): Promise<number> {
    const fromElement = await durationFromElement(file);
    if (fromElement > 0) return fromElement;

    console.warn('[AudioProcessor] El elemento multimedia no dio la duración; se decodifica');
    const fromDecode = await durationFromDecode(file);
    if (fromDecode > 0) return fromDecode;

    console.warn('[AudioProcessor] Decodificar tampoco dio la duración; se prueba con FFmpeg');
    const fromFFmpeg = await durationFromFFmpeg(file);
    if (fromFFmpeg > 0) return fromFFmpeg;

    console.warn('[AudioProcessor] ⚠️  No se pudo determinar la duración: se continúa sin ella');
    return 0;
}

/**
 * Detectar si un archivo ya está comprimido (evitar doble compresión)
 */
function isAlreadyCompressed(file: File): boolean {
    const compressedFormats = [
        'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a',
        'audio/aac', 'audio/ogg', 'audio/webm'
    ];
    if (compressedFormats.includes(file.type)) return true;

    const compressedExtensions = ['.mp3', '.m4a', '.aac', '.ogg', '.webm'];
    return compressedExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
}

/**
 * Procesar audio para subir - Estrategia adaptativa por proveedor
 */
export async function processAudioForUpload(
    file: File,
    onProgress?: (stage: string, progress: number) => void,
    options: {
        provider?: 'groq' | 'gemini';
        compressionThreshold?: number;
        chunkingThreshold?: number;
        forceCompression?: boolean;
    } = {}
): Promise<ProcessedAudio> {
    const originalSize = file.size;
    const provider = options.provider || 'groq';
    const duration = await getMediaDuration(file);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`[AudioProcessor] Processing for ${provider.toUpperCase()}`);
    console.log('[AudioProcessor] File:', file.name);
    console.log('[AudioProcessor] Size:', (originalSize / 1024 / 1024).toFixed(2), 'MB');
    console.log('[AudioProcessor] Type:', file.type || 'unknown');
    if (duration > 0) {
        console.log('[AudioProcessor] Duration:', (duration / 60).toFixed(1), 'minutes');
    } else {
        console.log('[AudioProcessor] ⚠️  Duration: Could not detect (will estimate)');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (provider === 'gemini') {
        return processForGemini(file, duration, onProgress);
    } else {
        return processForGroq(file, duration, onProgress, options);
    }
}

/**
 * Procesar para GEMINI
 * NUEVA ESTRATEGIA CON FFMPEG:
 * - Audio corto (< umbral): Paso directo
 * - Audio largo (>= umbral):
 *   - Si es formato contenedor (M4A, WEBM, etc.): Chunking temporal con FFmpeg
 *   - Si es MP3/WAV: Paso directo (chunking binario se hace en gemini.ts)
 * - Video: Extraer audio @ 44.1kHz 128kbps
 */
async function processForGemini(
    file: File,
    duration: number,
    onProgress?: (stage: string, progress: number) => void
): Promise<ProcessedAudio> {
    const isVideo = file.type.startsWith('video/');
    const minutes = duration / 60;

    // AUDIO: Analizar estrategia
    if (!isVideo) {
        // ✅ CASO 1: audio corto de verdad.
        //
        // Antes bastaba con que el archivo pesara poco para saltarse el
        // troceado, y ahí se colaba el fallo: una clase de una hora en M4A a
        // 64 kbps pesa 18 MB, se daba por corta, y acababa troceada por bytes
        // en la capa de red — que es lo único que NO se puede hacer con un
        // contenedor M4A. Manda la duración; el tamaño sólo decide cuando no
        // hay duración que valga.
        const isSmallFile = file.size < 20 * 1024 * 1024;
        const knownDuration = Number.isFinite(minutes) && minutes > 0;
        const isShortDuration = knownDuration && minutes < CHUNKING_THRESHOLD_MINUTES;
        const isLikelyShort = isShortDuration || (!knownDuration && isSmallFile);

        if (isLikelyShort) {
            console.log(isShortDuration
                ? `[AudioProcessor] ✅ Normal file < ${CHUNKING_THRESHOLD_MINUTES}min: Direct Pass`
                : `[AudioProcessor] ✅ Small file of unknown length (${(file.size / 1024 / 1024).toFixed(2)}MB): Direct Pass`);
            console.log('[AudioProcessor] Strategy: Upload as-is to Gemini');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            return {
                chunks: [file],
                originalSize: file.size,
                compressedSize: file.size,
                wasCompressed: false,
                wasChunked: false,
                chunkingMethod: 'none',
                duration,
            };
        }

        // ✅ CASO 2: audio largo — SIEMPRE troceado por tiempo con FFmpeg.
        //
        // Aquí había una excepción para MP3/WAV que los dejaba pasar enteros
        // para que la capa de Gemini los cortara por bytes. Cortar por bytes
        // sólo produce un fragmento válido: el primero. Los demás salen sin
        // cabecera —un WAV sin su RIFF no es un archivo de audio, y un MP3
        // empieza a mitad de trama— y se subían igual. De ahí venían los
        // "fragmento X falló" y las transcripciones que no se parecían al
        // audio. Cortar por tiempo es lo único que da fragmentos que se pueden
        // reproducir, y FFmpeg lo hace con `-c copy`, sin recodificar nada.
        if (!isFFmpegSupported()) {
            console.warn('[AudioProcessor] ⚠️ FFmpeg not supported, falling back to MP3 conversion');
            return await fallbackToMP3Conversion(file, duration, onProgress);
        }

        console.log(`[AudioProcessor] 🎯 Long audio detected (>=${CHUNKING_THRESHOLD_MINUTES}min)`);
        console.log('[AudioProcessor] 🔧 Using FFmpeg temporal chunking (NO re-encoding)');

        try {
            onProgress?.('chunking', 0);

            const result = await chunkFileTemporally(
                file,
                duration, // Pasar duración desde Web Audio API
                CHUNKING_THRESHOLD_MINUTES,
                GEMINI_CHUNK_OVERLAP,
                (stage, p) => onProgress?.('chunking', p)
            );

            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('[AudioProcessor] ✅ FFmpeg Temporal Chunking Complete');
            console.log(`[AudioProcessor] Created ${result.chunks.length} chunks`);
            console.log(`[AudioProcessor] Format: ${result.format} (preserved)`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            return {
                chunks: result.chunks.map(c => c.file),
                originalSize: file.size,
                compressedSize: result.chunks.reduce((sum, c) => sum + c.file.size, 0),
                wasCompressed: false, // No recodificamos
                wasChunked: true,
                chunkingMethod: 'temporal-ffmpeg',
                duration: result.totalDuration,
                chunkMetadata: result.chunks.map(c => ({
                    startTime: c.startTime,
                    endTime: c.endTime,
                    index: c.index
                }))
            };

        } catch (e) {
            console.error('[AudioProcessor] FFmpeg chunking failed:', e);
            console.warn('[AudioProcessor] Falling back to MP3 conversion...');
            return await fallbackToMP3Conversion(file, duration, onProgress);
        }
    }

    // VIDEO: Extraer audio en alta calidad
    console.log('[AudioProcessor] 🎬 Video file: Extracting HQ audio');
    console.log('[AudioProcessor] Target: 44.1kHz @ 128kbps MP3');
    onProgress?.('compressing', 0);

    const extracted = await extractAudio(
        file,
        duration,
        GEMINI_SAMPLE_RATE,
        GEMINI_BITRATE,
        'Gemini HQ',
        (p) => onProgress?.('compressing', p),
    );

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return {
        chunks: [extracted.file],
        originalSize: file.size,
        compressedSize: extracted.compressedSize,
        wasCompressed: true,
        wasChunked: false,
        chunkingMethod: 'none',
        duration: extracted.duration,
    };
}

/**
 * Fallback: Convertir a MP3 para permitir chunking binario
 * (usado cuando FFmpeg falla o no está disponible)
 */
async function fallbackToMP3Conversion(
    file: File,
    duration: number,
    onProgress?: (stage: string, progress: number) => void
): Promise<ProcessedAudio> {
    console.log('[AudioProcessor] 🔄 Fallback: Converting to MP3 for safe chunking');
    console.log('[AudioProcessor] Target: 44.1kHz @ 128kbps MP3');

    const converted = await extractAudio(
        file,
        duration,
        GEMINI_SAMPLE_RATE,
        GEMINI_BITRATE,
        'Gemini Safe-Chunking',
        (p) => onProgress?.('compressing', p),
    );

    return {
        chunks: [converted.file],
        originalSize: file.size,
        compressedSize: converted.compressedSize,
        wasCompressed: true,
        wasChunked: false,
        chunkingMethod: 'none',
        duration: converted.duration,
    };
}

/**
 * Procesar para GROQ
 * - Audio < 25MB: Paso directo
 * - Audio > 25MB o Video: Comprimir @ 16kHz 64kbps
 * - Si resultado > 20MB: Chunkear
 */
async function processForGroq(
    file: File,
    duration: number,
    onProgress?: (stage: string, progress: number) => void,
    options: any = {}
): Promise<ProcessedAudio> {
    const isVideo = file.type.startsWith('video/');
    const forceCompression = options.forceCompression ?? false;
    const needsCompression = file.size > GROQ_MAX_SIZE || isVideo || forceCompression;

    // Paso 1: ¿Necesita compresión?
    if (!needsCompression) {
        console.log('[AudioProcessor] ✅ Audio < 25MB: Direct Pass');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return {
            chunks: [file],
            originalSize: file.size,
            compressedSize: file.size,
            wasCompressed: false,
            wasChunked: false,
            chunkingMethod: 'none',
            duration,
        };
    }

    // Paso 2: Comprimir/Extraer
    const action = isVideo ? 'Extracting audio' : 'Compressing';
    console.log(`[AudioProcessor] 📦 ${action} for Groq`);
    console.log('[AudioProcessor] Target: 16kHz @ 64kbps MP3 (Whisper optimized)');
    onProgress?.('compressing', 0);

    const compressed = await extractAudio(
        file,
        duration,
        GROQ_SAMPLE_RATE,
        GROQ_BITRATE,
        'Groq Whisper',
        (p) => onProgress?.('compressing', p),
    );

    let currentFile = compressed.file;
    let currentDuration = compressed.duration;

    // Paso 3: ¿Necesita chunking?
    if (currentFile.size <= GROQ_CHUNK_SIZE) {
        console.log('[AudioProcessor] ✅ No chunking needed');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return {
            chunks: [currentFile],
            originalSize: file.size,
            compressedSize: currentFile.size,
            wasCompressed: true,
            wasChunked: false,
            chunkingMethod: 'none',
            duration: currentDuration,
        };
    }

    // Paso 4: Chunkear.
    //
    // El troceado binario sólo vale para MP3/WAV: cortar un M4A por bytes
    // produce fragmentos sin cabecera que Whisper rechaza. Cuando la extracción
    // la ha hecho FFmpeg (salida AAC/M4A) se trocea por tiempo con el propio
    // FFmpeg, que es lo único que garantiza fragmentos reproducibles.
    onProgress?.('chunking', 0);
    const isBinarySafe = currentFile.type === 'audio/mpeg' || currentFile.type === 'audio/wav';

    if (!isBinarySafe && isFFmpegSupported() && currentDuration > 0) {
        try {
            console.log('[AudioProcessor] ✂️  Contenedor no divisible por bytes: troceado temporal con FFmpeg');
            // A 64 kbps, 20 MB son ~41 min. Se deja margen y sin solape: en Groq
            // no hay deduplicación y el solape se colaría dos veces en el texto.
            const result = await chunkFileTemporally(
                currentFile,
                currentDuration,
                40,
                0,
                (_stage, p) => onProgress?.('chunking', p),
            );
            onProgress?.('chunking', 1);
            console.log('[AudioProcessor] Created', result.chunks.length, 'temporal chunks');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            return {
                chunks: result.chunks.map(c => c.file),
                originalSize: file.size,
                compressedSize: currentFile.size,
                wasCompressed: true,
                wasChunked: true,
                chunkingMethod: 'temporal-ffmpeg',
                duration: currentDuration,
                chunkMetadata: result.chunks.map(c => ({
                    startTime: c.startTime,
                    endTime: c.endTime,
                    index: c.index,
                })),
            };
        } catch (e: any) {
            console.warn(`[AudioProcessor] ⚠️  Troceado temporal fallido (${e?.message || e}); se recodifica a MP3 para poder trocear`);
            const remuxed = await compressAudio(
                currentFile,
                (p) => onProgress?.('compressing', p),
                fitSampleRate(currentDuration, GROQ_SAMPLE_RATE),
                GROQ_BITRATE,
                'Groq Whisper (remux)',
                currentDuration,
            );
            currentFile = remuxed.file;
            currentDuration = remuxed.duration;
        }
    }

    console.log('[AudioProcessor] ✂️  File > 20MB: Binary Chunking');
    const chunks = chunkFile(currentFile, GROQ_CHUNK_SIZE);
    onProgress?.('chunking', 1);

    console.log('[AudioProcessor] Created', chunks.length, 'chunks');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return {
        chunks,
        originalSize: file.size,
        compressedSize: currentFile.size,
        wasCompressed: true,
        wasChunked: true,
        chunkingMethod: 'binary',
        duration: currentDuration,
    };
}

/**
 * Techo de memoria para la ruta Web Audio.
 *
 * `decodeAudioData` deja el audio entero descomprimido en el heap (Float32 por
 * canal). Pasado cierto tamaño la pestaña no lanza un error: se muere, y el
 * usuario ve un reinicio sin explicación. Es preferible negarse a intentarlo y
 * decir por qué.
 */
const MAX_DECODE_BYTES = 600 * 1024 * 1024;

/** Bytes de PCM que ocuparía decodificar `duration` segundos a `sampleRate`. */
function estimateDecodedBytes(duration: number, sampleRate: number): number {
    // Float32 (4 bytes) por muestra y hasta 2 canales antes de mezclar a mono.
    return duration * sampleRate * 2 * 4;
}

/**
 * Baja la calidad de destino en archivos largos para que quepan en memoria.
 * Para voz, 22 kHz o 16 kHz mono no cambia nada que el modelo pueda notar.
 */
function fitSampleRate(duration: number, preferred: number): number {
    if (duration <= 0) return preferred;
    for (const rate of [preferred, 32000, 22050, 16000]) {
        if (rate <= preferred && estimateDecodedBytes(duration, rate) <= MAX_DECODE_BYTES) return rate;
    }
    return 16000;
}

/**
 * Ruta preferente para vídeo (y para audio que haya que recodificar entero):
 * FFmpeg si está disponible, y si no la Web Audio API.
 */
async function extractAudio(
    file: File,
    duration: number,
    sampleRate: number,
    bitrateKbps: number,
    label: string,
    onProgress?: (progress: number) => void,
): Promise<CompressionResult> {
    if (isFFmpegSupported()) {
        try {
            console.log(`[AudioProcessor] 🎬 ${label}: extrayendo con FFmpeg (sin decodificar en memoria)`);
            const { file: extracted } = await extractAudioTrack(file, { sampleRate, bitrateKbps }, onProgress);
            const realDuration = duration > 0 ? duration : await getMediaDuration(extracted);
            return {
                file: extracted,
                originalSize: file.size,
                compressedSize: extracted.size,
                ratio: extracted.size / file.size,
                duration: realDuration,
            };
        } catch (e: any) {
            console.warn(`[AudioProcessor] ⚠️  FFmpeg no pudo extraer el audio (${e?.message || e}); se prueba con Web Audio`);
        }
    }

    const safeRate = fitSampleRate(duration, sampleRate);
    if (safeRate !== sampleRate) {
        console.warn(`[AudioProcessor] ⚠️  Archivo largo: se baja la calidad de ${sampleRate}Hz a ${safeRate}Hz para no agotar la memoria`);
    }
    return compressAudio(file, onProgress, safeRate, bitrateKbps, label, duration);
}

/**
 * Comprimir/Extraer audio con logging detallado
 */
async function compressAudio(
    file: File,
    onProgress?: (progress: number) => void,
    targetSampleRate: number = GROQ_SAMPLE_RATE,
    targetBitrate: number = GROQ_BITRATE,
    label: string = 'Audio',
    knownDuration: number = 0
): Promise<CompressionResult> {
    const startTime = Date.now();

    // Negarse con una explicación es mejor que morir sin ella.
    const projected = estimateDecodedBytes(knownDuration, targetSampleRate);
    if (knownDuration > 0 && projected > MAX_DECODE_BYTES) {
        throw new Error(
            `El archivo es demasiado largo para procesarlo en el navegador ` +
            `(${(knownDuration / 60).toFixed(0)} min necesitarían ~${Math.round(projected / 1024 / 1024)} MB de memoria). ` +
            `Conviértelo a MP3 o divídelo en partes más cortas antes de subirlo.`
        );
    }

    const arrayBuffer = await file.arrayBuffer();
    onProgress?.(0.1);

    // Decodificar audio a PCM
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: targetSampleRate,
    });

    let audioBuffer: AudioBuffer;
    try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (decodeError: any) {
        throw new Error(`No se pudo decodificar el audio: ${decodeError?.message || decodeError}. El archivo puede estar dañado o usar un códec no soportado.`);
    } finally {
        await audioCtx.close().catch(() => { /* ya cerrado */ });
    }
    onProgress?.(0.3);

    // Calcular duración del audio extraído
    const extractedDuration = audioBuffer.length / audioBuffer.sampleRate;

    // Obtener datos mono
    const monoData = getMono(audioBuffer);
    onProgress?.(0.4);

    // Codificar a MP3
    const mp3Data = await encodeMp3(monoData, targetSampleRate, targetBitrate, onProgress);

    const mp3Blob = new Blob(mp3Data as unknown as BlobPart[], { type: 'audio/mpeg' });
    const mp3File = new File(
        [mp3Blob],
        file.name.replace(/\.[^.]+$/, '') + '_processed.mp3',
        { type: 'audio/mpeg' }
    );

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // Logs detallados
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`[AudioProcessor] ✅ ${label} Processing Complete`);
    console.log('[AudioProcessor] Original:', file.name);
    console.log('[AudioProcessor] Original size:', (file.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('[AudioProcessor] Duration:', (extractedDuration / 60).toFixed(1), 'minutes (', extractedDuration.toFixed(1), 's )');
    console.log('[AudioProcessor] Quality:', targetSampleRate, 'Hz @', targetBitrate, 'kbps');
    console.log('[AudioProcessor] Output size:', (mp3File.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('[AudioProcessor] Compression ratio:', (mp3File.size / file.size * 100).toFixed(1), '%');
    console.log('[AudioProcessor] Processing time:', totalTime, 's');

    return {
        file: mp3File,
        originalSize: file.size,
        compressedSize: mp3File.size,
        ratio: mp3File.size / file.size,
        duration: extractedDuration,
    };
}

/**
 * Mezclar buffer de audio a mono Int16Array
 */
function getMono(buffer: AudioBuffer): Int16Array {
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    const output = new Int16Array(length);

    if (channels === 1) {
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) {
            output[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
        }
    } else {
        // Mezclar todos los canales
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        for (let i = 0; i < length; i++) {
            const mixed = (left[i] + right[i]) / 2;
            output[i] = Math.max(-32768, Math.min(32767, Math.round(mixed * 32767)));
        }
    }

    return output;
}

/**
 * Codificar Int16Array PCM a MP3 usando Web Worker
 */
function encodeMp3(
    samples: Int16Array,
    sampleRate: number,
    bitrate: number,
    onProgress?: (progress: number) => void
): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./audio-encoder.worker.js', import.meta.url), { type: 'module' });

        worker.onmessage = (e) => {
            const { type, progress, mp3Data, error } = e.data;

            if (type === 'progress') {
                onProgress?.(0.4 + progress * 0.6);
            } else if (type === 'complete') {
                worker.terminate();
                resolve(mp3Data);
            } else if (type === 'error') {
                worker.terminate();
                reject(new Error(error));
            }
        };

        worker.onerror = (err) => {
            worker.terminate();
            reject(err);
        };

        worker.postMessage({ pcmData: samples, sampleRate, bitrate });
    });
}

/**
 * Dividir archivo en chunks (binario - solo para MP3/WAV)
 */
function chunkFile(file: File, chunkSize: number = GROQ_CHUNK_SIZE): File[] {
    if (file.size <= chunkSize) return [file];

    const chunks: File[] = [];
    let offset = 0;
    let index = 0;

    while (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size);
        const blob = file.slice(offset, end);
        const chunkFile = new File(
            [blob],
            `${file.name.replace(/\.[^.]+$/, '')}_part${index + 1}.mp3`,
            { type: file.type || 'audio/mpeg' }
        );
        chunks.push(chunkFile);
        offset = end;
        index++;
    }

    return chunks;
}
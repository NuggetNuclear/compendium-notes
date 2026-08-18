import { chunkFileTemporally, isFFmpegSupported, extractAudioTrack, probeDuration } from './ffmpeg-chunker';
import { sanitizeDuration } from './duration';
import { CHUNK_SIZE_MINUTES as GEMINI_CHUNK_MINUTES, CHUNK_OVERLAP_SECONDS as GEMINI_CHUNK_OVERLAP } from './gemini';

export { sanitizeDuration };

/**
 * Todo el trabajo sobre el audio —trocear, extraer, recodificar— lo hace
 * FFmpeg, y FFmpeg necesita `SharedArrayBuffer`. La app manda las cabeceras
 * COOP/COEP que lo habilitan, así que esto sólo salta en un navegador que no
 * las respeta. Decirlo es mejor que fallar más abajo sin motivo aparente.
 */
const FFMPEG_REQUIRED =
    'Tu navegador no permite procesar audio en local (falta SharedArrayBuffer). ' +
    'Prueba con Chrome, Edge o Firefox actualizados.';


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
 * Obtener la duración de un archivo multimedia, por dos caminos.
 *
 * Se probó con uno solo —el elemento `<audio>`— y resultó ser el menos fiable:
 * en Chrome se queda cargando indefinidamente con archivos válidos, y como no
 * emite `error` tampoco había forma de enterarse. Eso bloqueaba el proceso
 * ANTES de la primera petición, con cualquier archivo. Detrás va FFmpeg, que
 * lee sólo las cabeceras.
 *
 * Devuelve 0 si ninguno lo consigue — nunca `Infinity` ni `NaN`, y nunca se
 * queda esperando.
 */
export async function getMediaDuration(file: File): Promise<number> {
    const fromElement = await durationFromElement(file);
    if (fromElement > 0) return fromElement;

    console.warn('[AudioProcessor] El elemento multimedia no dio la duración; se prueba con FFmpeg');
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
        if (!isFFmpegSupported()) throw new Error(FFMPEG_REQUIRED);

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
 * Último recurso cuando el troceado por tiempo falla: recodificar el audio
 * entero y mandarlo sin trocear.
 *
 * Recodificar y trocear son dos órdenes distintas de FFmpeg, y que falle una no
 * significa que falle la otra (un contenedor raro se deja recodificar aunque no
 * se deje cortar con `-c copy`). Sale un solo archivo: la capa de Gemini avisa
 * de que va entero y de que puede quedarse corto, que es mejor que no tener
 * nada.
 */
async function fallbackToMP3Conversion(
    file: File,
    duration: number,
    onProgress?: (stage: string, progress: number) => void
): Promise<ProcessedAudio> {
    console.log('[AudioProcessor] 🔄 Fallback: recodificando el audio entero');

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

    // Paso 4: trocear por tiempo con FFmpeg.
    //
    // Aquí quedaba un troceado por bytes para cuando la salida fuera MP3/WAV o
    // no se supiera la duración. Ya no puede darse lo primero —lo que sale de
    // la extracción es siempre M4A— y lo segundo producía justo lo que no se
    // puede hacer con un M4A: fragmentos sin cabecera, que Whisper rechaza. Si
    // falta la duración se mide sobre el archivo comprimido, y si no hay manera
    // se dice, en lugar de mandar trozos que no son audio.
    onProgress?.('chunking', 0);

    if (!(currentDuration > 0)) {
        console.warn('[AudioProcessor] ⚠️  Duración desconocida tras comprimir: se vuelve a medir');
        currentDuration = await getMediaDuration(currentFile);
    }
    if (!(currentDuration > 0)) {
        throw new Error(
            'No se pudo determinar la duración del audio, así que no se puede dividir en partes. ' +
            'Conviértelo a MP3 y vuelve a subirlo.'
        );
    }

    console.log('[AudioProcessor] ✂️  Troceado temporal con FFmpeg');
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
}

/**
 * Extrae/recodifica la pista de audio con FFmpeg.
 *
 * Aquí había una segunda implementación completa con la Web Audio API y lamejs:
 * `decodeAudioData` a PCM, mezcla a mono, y un worker que codificaba MP3. Sólo
 * existía como respaldo por si FFmpeg no estaba, y arrastraba consigo todo el
 * andamiaje que ese respaldo necesitaba —`MAX_DECODE_BYTES`, `fitSampleRate`,
 * `estimateDecodedBytes`— porque decodificar deja el audio entero
 * descomprimido en el heap y con un archivo largo mataba la pestaña.
 *
 * FFmpeg hace lo mismo sin sacar el audio del wasm, ya es una dependencia, y ya
 * se intentaba PRIMERO. El respaldo, además, se negaba a procesar los archivos
 * largos —que son justo los que llegaban hasta aquí—, así que su único
 * resultado real era un mensaje de error más caro.
 */
async function extractAudio(
    file: File,
    duration: number,
    sampleRate: number,
    bitrateKbps: number,
    label: string,
    onProgress?: (progress: number) => void,
): Promise<CompressionResult> {
    if (!isFFmpegSupported()) throw new Error(FFMPEG_REQUIRED);

    console.log(`[AudioProcessor] 🎬 ${label}: extrayendo con FFmpeg`);
    const { file: extracted } = await extractAudioTrack(file, { sampleRate, bitrateKbps }, onProgress);
    const realDuration = duration > 0 ? duration : await getMediaDuration(extracted);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`[AudioProcessor] ✅ ${label} Processing Complete`);
    console.log('[AudioProcessor] Original size:', (file.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('[AudioProcessor] Output size:', (extracted.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('[AudioProcessor] Quality:', sampleRate, 'Hz @', bitrateKbps, 'kbps');

    return {
        file: extracted,
        originalSize: file.size,
        compressedSize: extracted.size,
        ratio: extracted.size / file.size,
        duration: realDuration,
    };
}

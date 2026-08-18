import { progress, m } from './progress';
import { repetitionResumePoint, shiftTimestamps, secondsToLabel } from './text-cleanup';
import { throwIfCancelled, isCancelledError } from './pipeline-control';

/**
 * Recuperación de un modelo atascado repitiendo.
 *
 * El fallo es conocido y lo cometen los dos proveedores: en algún punto del
 * audio —un silencio largo, un tramo de ruido, una muletilla— el modelo entra
 * en bucle ("no, no, no, …", "gracias por ver el video" una y otra vez) y ya no
 * sale. Detectarlo estaba resuelto: Gemini corta el stream en cuanto lo ve y
 * Whisper lo tacha del texto. Lo que NO estaba resuelto es lo que se pierde
 * detrás: desde el segundo en que el modelo se enganchó hasta el final de ese
 * fragmento, veinte minutos de clase podían quedarse sin transcribir sin que
 * nada lo dijera.
 *
 * Aquí está la respuesta a la pregunta obvia —¿se reintenta el fragmento entero
 * o sólo el trozo estropeado?—: sólo el trozo. Por tres motivos, y ninguno es
 * el ahorro:
 *
 *  1. Repetir el fragmento entero suele repetir el bucle. La temperatura es
 *     0.1 y el audio es el mismo: el modelo vuelve a atascarse en el mismo
 *     silencio, y lo único que se consigue es gastar otra petición de la cuota
 *     gratuita para acabar igual. Empezar en otro punto cambia el contexto y
 *     rompe el patrón que lo enganchó.
 *  2. Lo transcrito antes del bucle es bueno. Tirarlo para pedirlo otra vez es
 *     arriesgarse a que la segunda versión salga peor.
 *  3. El trozo que queda es más corto que el fragmento, así que cabe de sobra
 *     en el presupuesto de tokens — que es justo lo que el bucle había
 *     agotado.
 *
 * El precio es que hay que saber POR DÓNDE cortar, y eso lo dan las marcas de
 * tiempo que el propio modelo va escribiendo (`repetitionResumePoint`). Sin una
 * marca delante del bucle no hay punto de corte y se señala el hueco.
 */

/**
 * Reintentos por fragmento. Dos, no más: si el modelo se atasca tres veces en
 * el mismo audio, el problema es el audio (ruido, silencio largo, música) y la
 * cuarta petición saldría igual. A partir de ahí es más honesto señalar el
 * hueco que seguir gastando cuota.
 */
const MAX_RECOVERIES = 2;

/**
 * Cola mínima que merece una petición. Por debajo de esto, lo que falta cabe
 * en una frase y no compensa ni la subida del recorte.
 */
const MIN_TAIL_SECONDS = 20;

/**
 * Avance mínimo entre un intento y el siguiente.
 *
 * Protege contra el caso peor: el reintento se vuelve a atascar nada más
 * empezar, en el mismo silencio, y devuelve un punto de reanudación igual o
 * anterior al que ya teníamos. Sin esta comprobación eso es un bucle de
 * peticiones idénticas; con ella se para en seco y se marca el hueco.
 */
const MIN_ADVANCE_SECONDS = 5;

/**
 * Una pasada de transcripción sobre un audio concreto.
 *
 * `offsetSec` es el segundo del fragmento original en que empieza `audio`: sirve
 * para que quien transcribe pueda situar el progreso y contarle al modelo de
 * qué tramo se trata. El texto que devuelve tiene marcas RELATIVAS a `audio`
 * (su primera palabra es `[00:00]`); de reubicarlas se encarga esto.
 */
export type RecoveryPass = (
    audio: File,
    offsetSec: number,
    remainingSec: number,
) => Promise<string>;

export interface LoopRecoveryResult {
    /** Texto cosido, con las marcas de tiempo del fragmento original. */
    text: string;
    /** Cuántas veces hubo que reintentar un trozo. */
    recoveries: number;
    /** Segundo a partir del cual el audio se dio por perdido, si se dio. */
    lostFrom: number | null;
}

/**
 * Transcribe `file` reintentando SÓLO el tramo que un bucle eche a perder.
 *
 * Es transparente para quien no se atasca: sin bucle hay exactamente una
 * pasada y el texto sale tal cual.
 */
export async function transcribeWithLoopRecovery(opts: {
    file: File;
    durationSec: number;
    /** Etiqueta para los logs, p. ej. "Gemini Chunk 3". */
    label: string;
    /** Fragmento al que pertenece, para el tablero de progreso. */
    chunkIndex?: number;
    /**
     * Segundo del audio COMPLETO en que empieza `file`. Sólo se usa para que el
     * aviso del hueco diga el minuto que el usuario ve en su reproductor, no el
     * del fragmento.
     */
    timeBaseSec?: number;
    pass: RecoveryPass;
}): Promise<LoopRecoveryResult> {
    const { file, durationSec, label, chunkIndex, timeBaseSec = 0, pass } = opts;

    const parts: string[] = [];
    let offsetSec = 0;
    let audio = file;
    let recoveries = 0;
    let lostFrom: number | null = null;

    while (true) {
        throwIfCancelled();
        const remaining = durationSec > 0 ? Math.max(0, durationSec - offsetSec) : 0;
        const text = await pass(audio, offsetSec, remaining);

        // Un rescate que vuelve vacío —el modelo no dio nada, o se agotaron sus
        // reintentos— no invalida lo ya transcrito, pero su tramo sí se perdió:
        // sin esto el documento acabaría antes de tiempo y sin decirlo.
        if (offsetSec > 0 && !text.trim()) {
            console.warn(`[${label}] ❌ El rescate desde ${secondsToLabel(offsetSec)} no devolvió nada`);
            lostFrom = offsetSec;
            break;
        }

        const point = repetitionResumePoint(text);
        if (!point) {
            // Camino normal: ni bucle, ni bucle localizable.
            parts.push(shiftTimestamps(text, offsetSec));
            break;
        }

        // Lo anterior al bucle se conserva; el segmento que el bucle estropeó
        // se descarta entero y se vuelve a pedir desde su marca.
        if (point.kept.trim()) parts.push(shiftTimestamps(point.kept, offsetSec));

        const resumeAt = offsetSec + point.resumeSec;
        const tail = durationSec > 0 ? durationSec - resumeAt : 0;

        console.warn(`[${label}] 🔁 Bucle de repetición desde ${secondsToLabel(resumeAt)} — quedan ${tail.toFixed(0)}s`);

        const canRetry =
            recoveries < MAX_RECOVERIES &&
            resumeAt >= offsetSec + MIN_ADVANCE_SECONDS &&
            tail >= MIN_TAIL_SECONDS;

        if (!canRetry) {
            // Aun sin reintento, el tramo perdido queda dicho: un documento
            // que parece completo es peor que uno con el hueco señalado.
            if (tail >= MIN_TAIL_SECONDS) lostFrom = resumeAt;
            break;
        }

        let slice: File;
        try {
            // Carga diferida: FFmpeg sólo hace falta si hay algo que recuperar,
            // y quien transcribe un audio corto no debería pagar su descarga.
            const { sliceAudio, isFFmpegSupported } = await import('./ffmpeg-chunker');
            if (!isFFmpegSupported()) throw new Error('FFmpeg no disponible en este navegador');
            slice = await sliceAudio(file, resumeAt, durationSec > 0 ? durationSec : undefined);
        } catch (e: any) {
            if (isCancelledError(e)) throw e;
            // Sin recorte no hay reintento posible: se señala el hueco.
            console.error(`[${label}] ❌ No se pudo recortar el audio para reintentar: ${e?.message || e}`);
            lostFrom = resumeAt;
            break;
        }

        recoveries++;
        progress.pushEvent('retry', m(
            `El modelo se atascó en ${secondsToLabel(resumeAt)} — se reintenta sólo desde ahí`,
            `The model got stuck at ${secondsToLabel(resumeAt)} — retrying from there only`,
        ), { chunk: chunkIndex });

        audio = slice;
        offsetSec = resumeAt;
    }

    if (lostFrom !== null) {
        const desde = secondsToLabel(timeBaseSec + lostFrom).slice(1, -1);
        const hasta = secondsToLabel(timeBaseSec + durationSec).slice(1, -1);
        // El aviso lleva delante la marca RELATIVA del fragmento, como el resto
        // de su texto: así el cosido lo coloca en su sitio del audio completo en
        // lugar de dejarlo pegado al último párrafo.
        parts.push(`${secondsToLabel(lostFrom)} ` + m(
            `[⚠️ El modelo se atascó repitiendo: falta el audio de ${desde} a ${hasta}]`,
            `[⚠️ The model got stuck repeating: audio missing from ${desde} to ${hasta}]`,
        ));
        progress.pushEvent('warn', m(
            `No se pudo recuperar el audio desde ${desde}: queda señalado en la transcripción`,
            `Could not recover the audio from ${desde}: it is marked in the transcript`,
        ), { chunk: chunkIndex });
    } else if (recoveries > 0) {
        progress.pushEvent('success', m(
            'Recuperado el tramo que el modelo había repetido',
            'Recovered the stretch the model was repeating',
        ), { chunk: chunkIndex });
    }

    return { text: parts.join('\n').trim(), recoveries, lostFrom };
}

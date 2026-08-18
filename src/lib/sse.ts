import { throwIfCancelled } from './pipeline-control';

/**
 * Lectura de respuestas en streaming (SSE), compartida por los proveedores.
 *
 * Gemini y Groq mandan formatos distintos dentro de cada `data:` —uno
 * `candidates[].content.parts[].text`, el otro `choices[].delta.content`— pero
 * el sobre es el mismo: líneas `data: {...}`, un `[DONE]` al final, y un socket
 * que puede quedarse mudo sin cerrarse.
 *
 * Esto último estaba resuelto dos veces, con la misma función copiada palabra
 * por palabra en los dos archivos. Es infraestructura que ya costó un fallo
 * real —un stream cortado a media respuesta dejaba la lectura esperando para
 * siempre—, y tenerla duplicada significa que el siguiente arreglo hay que
 * acordarse de hacerlo en dos sitios.
 */

/** Silencio máximo tolerado DENTRO de un stream ya abierto. */
export const STREAM_STALL_MS = 90_000;

/**
 * `reader.read()` con plazo: la promesa de un stream que se queda mudo no se
 * rechaza sola, y sin esto una respuesta cortada a medias dejaba la lectura
 * esperando para siempre.
 */
export async function readWithDeadline<T>(
    reader: ReadableStreamDefaultReader<T>,
    ms: number,
    label: string,
): Promise<{ done: boolean; value?: T }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} dejó de enviar datos durante ${Math.round(ms / 1000)}s`)),
                    ms,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Recorre los objetos `data:` de una respuesta SSE.
 *
 * `onData` recibe cada payload ya parseado; devolver `false` corta la lectura y
 * cierra el socket (sirve para abandonar a un modelo atascado repitiendo sin
 * pagar la respuesta entera).
 *
 * Devuelve el cuerpo crudo y si llegó a ver alguna línea `data:`. Eso último lo
 * necesita quien acepte también una respuesta JSON entera por el mismo lector:
 * `streamGenerateContent` sin `alt=sse` devuelve un array de objetos, no SSE.
 */
export async function forEachSSE(
    response: Response,
    label: string,
    onData: (parsed: any) => boolean | void,
): Promise<{ raw: string; sawSSE: boolean; trailing: string }> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${label} devolvió una respuesta sin cuerpo`);

    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    let sawSSE = false;
    let stop = false;

    while (!stop) {
        throwIfCancelled();
        const { done, value } = await readWithDeadline(reader, STREAM_STALL_MS, label);
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        raw += piece;
        buffer += piece;

        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            sawSSE = true;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let parsed: any;
            try {
                parsed = JSON.parse(payload);
            } catch {
                continue;   // trozo incompleto: se recompone en la vuelta siguiente
            }
            if (onData(parsed) === false) { stop = true; break; }
        }
    }

    if (stop) await reader.cancel().catch(() => { /* ya cerrado */ });

    return { raw, sawSSE, trailing: buffer.trim() };
}

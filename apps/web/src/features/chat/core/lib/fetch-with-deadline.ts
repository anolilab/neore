import { TimeoutError } from "@/lib/errors";

/** How long a non-streaming gateway call (chat metadata, edit, media kick-off) may take end to end. */
export const GATEWAY_REQUEST_DEADLINE_MS = 30_000;

interface DeadlineOptions {
    /** The caller's own cancel. Its abort is rethrown as is, never reported as a timeout. */
    signal?: AbortSignal;
    timeoutMs?: number;
}

/**
 * `fetch` for a gateway call whose reply is a small JSON document, bounded by one deadline that covers the
 * headers AND the body. The body is read here, under the deadline, and handed back as a fresh `Response`, so
 * a stall mid-body cannot hang the caller's later `.json()`. A deadline rejects with `TimeoutError`
 * (a `NetworkError`); an abort from `options.signal` rejects with the original abort error.
 *
 * Not for streams: a long generation must not be cut by a whole-request timeout.
 */
export const fetchWithDeadline = async (url: string, init: RequestInit, options: DeadlineOptions = {}): Promise<Response> => {
    const timeoutMs = options.timeoutMs ?? GATEWAY_REQUEST_DEADLINE_MS;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
        deadline.abort();
    }, timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;

    try {
        const response = await fetch(url, { ...init, signal });
        const body = await response.arrayBuffer();

        return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
    } catch (error) {
        if (deadline.signal.aborted && !options.signal?.aborted) {
            throw new TimeoutError(
                timeoutMs,
                "The server took too long to respond. Your request may still go through, so check the conversation before trying again.",
            );
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
};

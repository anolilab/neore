import { useAsRef } from "@ui/hooks/use-as-ref";
import { useEffect, useState } from "react";

/**
 * Loads a URL for a preview. A deadline and the unmount both abort the
 * request, so a stalled URL cannot hold a preview forever. Each result is kept
 * with the URL it answers, so a changed URL reads as loading until its own
 * request settles.
 */

export type FetchedResource<T> = { status: "error" } | { status: "loading" } | { status: "ready"; value: T };

export type FetchedText = FetchedResource<string>;

const FETCH_TIMEOUT_MS = 30_000;
const LOADING = { status: "loading" } as const;

/**
 * The most text a preview reads. A table, a JSON Lines file and a diagram are
 * all shown from the start of the file, so a larger one is not worth the
 * memory or the parse: the caller gets the error state and shows the download
 * card instead.
 */
export const MAX_FETCHED_TEXT_BYTES = 1_000_000;

const tooLarge = (maxBytes: number): Error => new Error(`The file is larger than ${String(maxBytes)} bytes`);

/**
 * Reads a response as text, refusing one over `maxBytes`. `Content-Length` is a
 * quick refusal, but it can be absent or describe the compressed size, so the
 * budget is enforced on the bytes actually read, and the body is cancelled as
 * soon as it is spent.
 */
export const readTextWithin = async (response: Response, maxBytes: number): Promise<string> => {
    const declared = Number(response.headers.get("content-length"));

    if (declared > maxBytes) {
        await response.body?.cancel();

        throw tooLarge(maxBytes);
    }

    if (!response.body) {
        const text = await response.text();

        // Without a stream the bytes cannot be counted; characters never outnumber them.
        if (text.length > maxBytes) {
            throw tooLarge(maxBytes);
        }

        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let received = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        received += value.byteLength;

        if (received > maxBytes) {
            await reader.cancel();

            throw tooLarge(maxBytes);
        }

        text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
};

const load = async <T>(url: string, read: (response: Response) => Promise<T>, signal: AbortSignal): Promise<FetchedResource<T>> => {
    try {
        const response = await fetch(url, { signal });

        if (!response.ok) {
            return { status: "error" };
        }

        return { status: "ready", value: await read(response) };
    } catch {
        return { status: "error" };
    }
};

/**
 * Fetches `url` and turns the response into a `T` with `read`. `read` may
 * change identity between renders without refetching; only `url` restarts it.
 */
export const useFetchedResource = <T>(url: string, read: (response: Response) => Promise<T>): FetchedResource<T> => {
    const readRef = useAsRef(read);
    const [result, setResult] = useState<{ state: FetchedResource<T>; url: string }>();

    useEffect(() => {
        const controller = new AbortController();
        const deadline = setTimeout(() => {
            controller.abort();
        }, FETCH_TIMEOUT_MS);
        let cancelled = false;

        const run = async (): Promise<void> => {
            const state = await load(url, readRef.current, controller.signal);

            if (!cancelled) {
                setResult({ state, url });
            }
        };

        run();

        return () => {
            cancelled = true;
            clearTimeout(deadline);
            controller.abort();
        };
    }, [readRef, url]);

    return result?.url === url ? result.state : LOADING;
};

const readBoundedText = async (response: Response): Promise<string> => await readTextWithin(response, MAX_FETCHED_TEXT_BYTES);

export const useFetchedText = (url: string): FetchedText => useFetchedResource(url, readBoundedText);

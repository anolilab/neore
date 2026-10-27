import { useAsRef } from "@ui/hooks/use-as-ref";
import { isFetchableUrl, useFetchableOrigins } from "@ui/hooks/use-fetchable-origins";
import { useEffect, useState } from "react";

/**
 * Loads a URL for a preview. Only the page's own origin, `data:`/`blob:` and the
 * origins given to the fetchable-origins provider are fetched. A deadline and the unmount both abort the
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
 * A decoder for a text body, chosen from its first two bytes: a UTF-16 byte-order
 * mark (FF FE little-endian, FE FF big-endian) selects that encoding, anything
 * else is UTF-8. Both decoders strip a leading byte-order mark of their own.
 */
const decoderFor = (head: Uint8Array): TextDecoder => {
    if (head[0] === 0xff && head[1] === 0xfe) {
        return new TextDecoder("utf-16le");
    }

    if (head[0] === 0xfe && head[1] === 0xff) {
        return new TextDecoder("utf-16be");
    }

    return new TextDecoder();
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const joined = new Uint8Array(a.byteLength + b.byteLength);

    joined.set(a);
    joined.set(b, a.byteLength);

    return joined;
};

/**
 * Reads a response as text, refusing one over `maxBytes`. `Content-Length` is a
 * quick refusal, but it can be absent or describe the compressed size, so the
 * budget is enforced on the bytes actually read, and the body is cancelled as
 * soon as it is spent. A UTF-16 byte-order mark at the start selects that
 * encoding for the whole body; otherwise it is UTF-8.
 */
export const readTextWithin = async (response: Response, maxBytes: number): Promise<string> => {
    const declared = Number(response.headers.get("content-length"));

    if (declared > maxBytes) {
        await response.body?.cancel();

        throw tooLarge(maxBytes);
    }

    if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());

        if (bytes.byteLength > maxBytes) {
            throw tooLarge(maxBytes);
        }

        return decoderFor(bytes).decode(bytes);
    }

    const reader = response.body.getReader();
    let decoder: TextDecoder | undefined;
    // The bytes held back until two have arrived, since the first chunk can be a single byte.
    let head: Uint8Array = new Uint8Array(0);
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

        if (decoder) {
            text += decoder.decode(value, { stream: true });
        } else {
            head = concatBytes(head, value);

            if (head.byteLength >= 2) {
                decoder = decoderFor(head);
                text += decoder.decode(head, { stream: true });
            }
        }
    }

    // A body of fewer than two bytes never chose an encoding: it is UTF-8.
    if (!decoder) {
        return new TextDecoder().decode(head);
    }

    return text + decoder.decode();
};

// The scheme is case-insensitive, as URL validation treats it.
const DATA_SCHEME_RE = /^data:/iu;
const DATA_URL_RE = /^data:([^,]*),(.*)$/isu;
const MEDIA_TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/u;
const BASE64_PARAM_RE = /;\s*base64$/iu;

/**
 * A `data:` URL as a `Response`, decoded here rather than fetched: the app's
 * CSP `connect-src` does not list `data:`, so `fetch` would refuse it. A body
 * goes through the same readers as a fetched one, so the byte budget applies
 * to the decoded bytes. Throws on a malformed URL or payload.
 */
export const dataUrlResponse = (url: string): Response => {
    // A raw # starts the fragment (a literal one is escaped as %23), so the payload ends there.
    const match = DATA_URL_RE.exec(url.split("#", 1)[0] ?? url);

    if (!match) {
        throw new Error("Not a valid data URL");
    }

    const [, header = "", payload = ""] = match;
    const isBase64 = BASE64_PARAM_RE.test(header);
    const mediaType = (header.split(";", 1)[0] ?? "").trim();

    // Refuse on the encoded length before anything is decoded. Base64 is 4 characters per 3 bytes. A percent escape
    // is 3 characters per byte, so a payload decodes to at least a third of its length: only longer than three times
    // the limit is certainly too large.
    const encodedLimit = isBase64 ? Math.ceil((MAX_FETCHED_TEXT_BYTES * 4) / 3) + 4 : MAX_FETCHED_TEXT_BYTES * 3;

    if (payload.length > encodedLimit) {
        throw tooLarge(MAX_FETCHED_TEXT_BYTES);
    }

    const decoded = decodeURIComponent(payload);
    const body = isBase64 ? Uint8Array.from(atob(decoded), (character) => character.codePointAt(0) ?? 0) : new TextEncoder().encode(decoded);

    return new Response(body, MEDIA_TYPE_RE.test(mediaType) ? { headers: { "content-type": mediaType } } : undefined);
};

export const loadResource = async <T>(
    url: string,
    read: (response: Response) => Promise<T>,
    signal: AbortSignal,
    allowedOrigins: ReadonlyArray<string>,
): Promise<FetchedResource<T>> => {
    // A refused destination is the error state (the download card), with no request made.
    if (!isFetchableUrl(url, allowedOrigins)) {
        return { status: "error" };
    }

    try {
        // `redirect: "error"`: the destination was checked for the URL given, so a redirect to another host is refused, not followed.
        const response = DATA_SCHEME_RE.test(url) ? dataUrlResponse(url) : await fetch(url, { credentials: "omit", redirect: "error", signal });

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
    const originsRef = useAsRef(useFetchableOrigins());
    const [result, setResult] = useState<{ state: FetchedResource<T>; url: string }>();

    useEffect(() => {
        const controller = new AbortController();
        const deadline = setTimeout(() => {
            controller.abort();
        }, FETCH_TIMEOUT_MS);
        let cancelled = false;

        const run = async (): Promise<void> => {
            const state = await loadResource(url, readRef.current, controller.signal, originsRef.current);

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
    }, [originsRef, readRef, url]);

    return result?.url === url ? result.state : LOADING;
};

const readBoundedText = async (response: Response): Promise<string> => await readTextWithin(response, MAX_FETCHED_TEXT_BYTES);

export const useFetchedText = (url: string): FetchedText => useFetchedResource(url, readBoundedText);

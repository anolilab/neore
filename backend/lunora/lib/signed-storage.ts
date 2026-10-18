/**
 * Serves Worker-signed download URLs: the GET half of `ctx.storage.getSignedUrl`.
 *
 * `@lunora/storage` mints them as `<publicBaseUrl>/<key>?exp&method&bucket&sig`
 * and leaves serving them to the app ("the Worker route handling the signed
 * URL should call `verifySignedUrl`"). Uploads do not come through here: they
 * go to the TUS upload route (`lib/upload-route.ts`).
 *
 * The signature is the whole authorization: it was minted by an authenticated
 * procedure for exactly this key, method and bucket, and it expires. There is
 * deliberately NO unsigned read path — user files are private, and anything
 * that needs a URL (a download link, a model provider fetching an attachment)
 * gets a short-lived signed one. Server code reads through `ctx.storage` and
 * never needs a URL at all (`lib/storage-read.ts`).
 */
import { verifySignedUrl } from "@lunora/storage";
import type { Storage } from "@lunora/storage";
import type { HttpActionCtx } from "lunorash/server";

/**
 * Types a browser may render inline from this origin. Everything else —
 * notably SVG, HTML and XML, which can carry script — is served as an
 * attachment, and every response is sandboxed by CSP besides.
 */
const INLINE_SAFE_TYPE = /^(?:image\/(?:png|jpe?g|gif|webp|avif)|application\/pdf|text\/plain|audio\/[\w.+-]+|video\/[\w.+-]+)$/u;

export interface SignedStorageOptions {
    /**
     * The `publicBaseUrl` storage signs against, as a full ORIGIN
     * (`http://localhost:8788`). `verifySignedUrl` documents this as a "host",
     * but a bare `localhost:8788` fails every signature as `bad_signature`.
     */
    expectedOrigin?: string;
    secret: string;
}

/** The object key a signed URL addresses: the whole path, minus the leading slash. */
export const keyFromPath = (pathname: string): string => {
    try {
        return decodeURIComponent(pathname.slice(1));
    } catch {
        return "";
    }
};

const verify = async (request: Request, options: SignedStorageOptions): Promise<{ key: string } | null> => {
    if (!options.secret) {
        return null;
    }

    const url = new URL(request.url);

    // No signature, no match: the caller gets the router's ordinary 404.
    if (!url.searchParams.has("sig")) {
        return null;
    }

    const verified = await verifySignedUrl(url, options.secret, options.expectedOrigin ? { expectedHost: options.expectedOrigin } : undefined);
    const key = keyFromPath(url.pathname);

    // One answer for every failure: the precise reason is a signing oracle.
    if (!verified.valid || verified.method !== "GET" || !key || verified.key !== key) {
        return null;
    }

    return { key };
};

const forbidden = (): Response => new Response("Forbidden", { status: 403 });

/** Response headers for a stored object: sandboxed, never sniffed, inline only for passive types. */
export const downloadHeaders = (contentType: string, size: number | undefined): Headers => {
    const headers = new Headers({
        "Cache-Control": "private, max-age=300",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
    });

    if (!INLINE_SAFE_TYPE.test(contentType)) {
        headers.set("Content-Disposition", "attachment");
    }

    if (size !== undefined) {
        headers.set("Content-Length", String(size));
    }

    return headers;
};

/** What a `Range` header asks for, against an object of `size` bytes. */
export type ByteRange = { kind: "all" } | { end: number; kind: "partial"; start: number } | { kind: "unsatisfiable" };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/u;

/**
 * One `bytes=` range, as RFC 9110 reads it. A header this does not understand
 * (another unit, several ranges, a reversed or empty spec) is ignored, which
 * serves the whole object; a range that starts past the end is unsatisfiable.
 */
export const parseRange = (header: string | null, size: number): ByteRange => {
    const match = header === null ? null : SINGLE_RANGE.exec(header.trim());

    if (!match || (match[1] === "" && match[2] === "")) {
        return { kind: "all" };
    }

    const [, first = "", last = ""] = match;

    if (first === "") {
        const suffix = Number(last);

        return suffix === 0 || size === 0 ? { kind: "unsatisfiable" } : { end: size - 1, kind: "partial", start: Math.max(0, size - suffix) };
    }

    const start = Number(first);

    if (last !== "" && Number(last) < start) {
        return { kind: "all" };
    }

    if (start >= size) {
        return { kind: "unsatisfiable" };
    }

    return { end: last === "" ? size - 1 : Math.min(Number(last), size - 1), kind: "partial", start };
};

type R2Range = NonNullable<NonNullable<Parameters<Storage["download"]>[1]>["range"]>;

/**
 * The R2 read that fetches a `Range` header's one span, or `"all"` when the
 * header is ignored (absent, another unit, several spans, a reversed span).
 * R2 resolves the span against the object, so the read returns the object's
 * size with its bytes and no metadata read is needed.
 */
const readFor = (header: string | null): R2Range | "all" => {
    const match = header === null ? null : SINGLE_RANGE.exec(header.trim());

    if (!match || (match[1] === "" && match[2] === "")) {
        return "all";
    }

    const [, first = "", last = ""] = match;

    // A suffix or an end too large to be an exact integer means "to the end", which is the
    // open-ended read: R2 then clamps nothing it needs and the object's size settles the rest.
    if (first === "") {
        return Number.isSafeInteger(Number(last)) ? { suffix: Number(last) } : { offset: 0 };
    }

    const start = Number(first);

    if (last !== "" && Number(last) < start) {
        return "all";
    }

    if (last === "" || !Number.isSafeInteger(start) || !Number.isSafeInteger(Number(last) + 1)) {
        return { offset: start };
    }

    return { length: Number(last) - start + 1, offset: start };
};

/**
 * R2's own refusal of a span past the end: its `R2Error` carries code 10039
 * (`The requested range is not satisfiable`). Anything else (a timeout, a reset,
 * a server fault) is NOT a range answer, and must surface as a failure.
 */
const R2_INVALID_RANGE_CODE = 10_039;

export const isInvalidRangeError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === R2_INVALID_RANGE_CODE) ||
        ("message" in error && typeof error.message === "string" && error.message.includes("not satisfiable")));

/**
 * Serves a verified GET or HEAD. A `Range` of one span is answered 206 (the
 * bytes come from R2 by range, so the rest never reaches the Worker), so
 * browsers can seek a video and a provider can fetch an attachment in parts.
 * A GET makes one R2 read: the object (or its range) carries the size. Only a
 * HEAD, and a range R2 returns nothing for, read the metadata.
 */
export const handleSignedGet = async (context: HttpActionCtx, request: Request, options: SignedStorageOptions): Promise<Response | null> => {
    const verified = await verify(request, options);

    if (!verified) {
        // Unsigned: not ours (fall through to 404). Signed but invalid: 403.
        return new URL(request.url).searchParams.has("sig") ? forbidden() : null;
    }

    if (!context.storage) {
        return new Response("Storage is not configured", { status: 503 });
    }

    const { storage } = context;
    const { key } = verified;
    const read = readFor(request.headers.get("Range"));

    if (request.method === "HEAD") {
        const metadata = await storage.getMetadata(key);

        if (!metadata) {
            return new Response("Not found", { status: 404 });
        }

        const headers = downloadHeaders(metadata.contentType ?? "application/octet-stream", metadata.size);

        headers.set("Accept-Ranges", "bytes");

        return new Response(null, { headers, status: 200 });
    }

    if (read === "all") {
        const object = await storage.download(key);

        if (!object) {
            return new Response("Not found", { status: 404 });
        }

        const headers = downloadHeaders(object.httpMetadata?.contentType ?? "application/octet-stream", object.size);

        headers.set("Accept-Ranges", "bytes");

        return new Response(object.body, { headers, status: 200 });
    }

    // R2 refuses some spans past the end by throwing or answering nothing; the
    // metadata then says whether the object is missing or the span unsatisfiable.
    const object = await storage.download(key, { range: read }).catch((error: unknown) => {
        if (isInvalidRangeError(error)) {
            return null;
        }

        throw error;
    });

    if (!object) {
        const metadata = await storage.getMetadata(key);

        return metadata ? unsatisfiable(metadata) : new Response("Not found", { status: 404 });
    }

    const range = parseRange(request.headers.get("Range"), object.size);

    if (range.kind !== "partial") {
        await object.body?.cancel();

        return unsatisfiable({ size: object.size });
    }

    const headers = downloadHeaders(object.httpMetadata?.contentType ?? "application/octet-stream", undefined);

    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", String(range.end - range.start + 1));
    headers.set("Content-Range", `bytes ${String(range.start)}-${String(range.end)}/${String(object.size)}`);

    return new Response(object.body, { headers, status: 206 });
};

/** 416 for a span the object cannot satisfy, with the object's size in `Content-Range`. */
const unsatisfiable = (metadata: { size: number } | null): Response => {
    const headers = new Headers({ "Accept-Ranges": "bytes", "Content-Range": `bytes */${String(metadata?.size ?? 0)}` });

    return new Response(null, { headers, status: 416 });
};

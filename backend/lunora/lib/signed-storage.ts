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

export const handleSignedGet = async (context: HttpActionCtx, request: Request, options: SignedStorageOptions): Promise<Response | null> => {
    const verified = await verify(request, options);

    if (!verified) {
        // Unsigned: not ours (fall through to 404). Signed but invalid: 403.
        return new URL(request.url).searchParams.has("sig") ? forbidden() : null;
    }

    if (!context.storage) {
        return new Response("Storage is not configured", { status: 503 });
    }

    const object = await context.storage.download(verified.key);

    if (!object) {
        return new Response("Not found", { status: 404 });
    }

    const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";

    return new Response(request.method === "HEAD" ? null : object.body, { headers: downloadHeaders(contentType, object.size), status: 200 });
};

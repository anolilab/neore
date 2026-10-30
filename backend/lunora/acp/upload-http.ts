/**
 * The device upload route: `POST /hosts/uploads` to create and `PATCH|HEAD /hosts/uploads/:uploadId` to continue,
 * where a paired computer's main process uploads a file its coding agent wrote (plans/acp-agent-host.md §4.8).
 * The bytes go over TUS to the same handler a browser's upload takes (`lib/upload-route.ts`), for the device's
 * user; what differs is how the caller proves who it is. A device holds no session and no API key, so every request
 * carries a signature under the `upload` domain (`devices/lib/signing.ts`):
 *
 *   neore-device-request:   base64url(JSON payload)        neore-device-signature: hex HMAC of that payload
 *
 *   POST    { v:1, kind:"upload", deviceId, issuedAt, method, size, type, nonce }
 *   HEAD    { v:1, kind:"upload", deviceId, issuedAt, method, uploadId }
 *   PATCH   { v:1, kind:"upload", deviceId, issuedAt, method, uploadId, offset, bodySha256 }
 *
 * The route checks each signed field against the request itself before the handler sees it, so a request cannot be
 * altered under a valid signature: the method, the path's upload id, the declared size and type, the offset and
 * the SHA-256 of the body. A create is claimed once by its nonce (held past the freshness window, so a replay is
 * refused); a `PATCH` or `HEAD` needs none, since the handler's own offset check makes a replayed chunk a no-op.
 *
 * Whose upload an id is comes from the signature's device owner, never from the request: the handler is built for
 * that user, and its state lives under that user's prefix, so another user's upload id answers 404.
 *
 * Every authentication failure is the same 401, answered before the body is read. Bound, in this order: the flood
 * guard, the device's owner (`shardRoutes`), the signature on that owner's shard, the request binding, the nonce.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import { DEVICE_SIGNATURE_WINDOW_MS } from "../devices/lib/constants";
import { isDeviceSignature } from "../devices/lib/signing";
import { sha256Hex, timingSafeEqual } from "../lib/crypto";
import { inShard } from "../lib/http-shard";
import { isUploadId } from "../lib/chat-upload-staging";
import { isUploadBucket, refusal, serveUserUpload } from "../lib/upload-route";
import { MAX_LENGTH } from "../lib/validators";
import { deviceOwner, floodAllowed, readCappedBytes } from "./http";
import {
    HOST_MEDIA_MAX_BYTES,
    HOST_MEDIA_MIME_TYPES,
    HOST_UPLOAD_MAX_CHUNK_BYTES,
    HOST_UPLOAD_PATH,
    HOST_UPLOAD_PAYLOAD_HEADER,
    HOST_UPLOAD_SIGNATURE_HEADER,
} from "./lib/constants";

/** A create's nonce is remembered past the window in which its signature would still be fresh (either side of now). */
const NONCE_TTL_MS = 2 * DEVICE_SIGNATURE_WINDOW_MS + 60_000;

export const HOST_UPLOAD_NONCE_SCOPE = "host-upload";

const MIN_NONCE_CHARS = 16;
const MAX_NONCE_CHARS = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const BASE64URL = /^[\w-]+$/u;

const unauthorized = (): Response => Response.json({ error: "unauthorized" }, { headers: { "Tus-Resumable": "1.0.0" }, status: 401 });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
};

const decodeBase64Url = (value: string): string | null => {
    if (!BASE64URL.test(value)) {
        return null;
    }

    try {
        const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
        const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

        return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0));
    } catch {
        return null;
    }
};

/** The `filetype` the TUS client declared in `Upload-Metadata` (`key base64` pairs, comma separated), lower-cased. */
const declaredType = (request: Request): string | null => {
    const pairs = (request.headers.get("upload-metadata") ?? "").split(",").map((pair) => pair.trim().split(" ", 2));

    // The upload handler lets `mimeType` take precedence over `filetype`, so the signed type would not be the
    // stored one: a create that names it is not bound to its signature.
    if (pairs.some(([key]) => key?.toLowerCase() === "mimetype")) {
        return null;
    }

    const declared = pairs.find(([key, value]) => key === "filetype" && value !== undefined)?.[1];

    if (declared === undefined) {
        return null;
    }

    try {
        return atob(declared).split(";", 1)[0]?.trim().toLowerCase() ?? null;
    } catch {
        return null;
    }
};

/** The upload id in the path of a `PATCH` or `HEAD`, or null for any other path. */
const uploadIdOf = (pathname: string): string | null => {
    const prefix = `${HOST_UPLOAD_PATH}/`;
    const id = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";

    return isUploadId(id) ? id : null;
};

const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** What the signed payload said the request is, checked against what it is. `null` when they differ. */
interface Binding {
    /** The nonce of a create, to claim once. */
    nonce?: string;
    /** The request to hand the TUS handler: the original, or one carrying the body that was hashed. */
    request: Request;
}

const bindCreate = (post: Record<string, unknown>, request: Request, pathname: string): Binding | Response | null => {
    const { nonce, size, type } = post;
    const declaredLength = request.headers.get("upload-length");

    if (
        pathname !== HOST_UPLOAD_PATH ||
        new URL(request.url).search !== "" ||
        typeof type !== "string" ||
        !isNonNegativeInteger(size) ||
        typeof nonce !== "string" ||
        nonce.length < MIN_NONCE_CHARS ||
        nonce.length > MAX_NONCE_CHARS ||
        declaredLength !== String(size) ||
        declaredType(request) !== type ||
        request.headers.has("upload-defer-length") ||
        request.body !== null
    ) {
        return null;
    }

    // The signature is genuine and the request matches it: what is refused now is the file, not the caller.
    if (size === 0 || size > HOST_MEDIA_MAX_BYTES) {
        return refusal(size === 0 ? 400 : 413, "That file cannot be uploaded.", { "Tus-Resumable": "1.0.0" });
    }

    if (!HOST_MEDIA_MIME_TYPES.includes(type)) {
        return refusal(415, "That file type cannot be uploaded.", { "Tus-Resumable": "1.0.0" });
    }

    return { nonce, request };
};

const bindContinue = async (post: Record<string, unknown>, request: Request, pathname: string): Promise<Binding | null> => {
    const uploadId = uploadIdOf(pathname);

    if (uploadId === null || post.uploadId !== uploadId || new URL(request.url).search !== "") {
        return null;
    }

    if (request.method === "HEAD") {
        return { request };
    }

    const { bodySha256, offset } = post;

    if (
        !isNonNegativeInteger(offset) ||
        typeof bodySha256 !== "string" ||
        !SHA256_HEX.test(bodySha256) ||
        request.headers.get("upload-offset") !== String(offset)
    ) {
        return null;
    }

    const body = await readCappedBytes(request, HOST_UPLOAD_MAX_CHUNK_BYTES);

    if (body === null || !timingSafeEqual(await sha256Hex(body), bodySha256)) {
        return null;
    }

    // The handler reads the same bytes that were hashed, not a second read of a stream.
    return { request: new Request(request.url, { body, headers: request.headers, method: "PATCH" }) };
};

export const hostUploadHttpAction = async (context: HttpActionCtx, request: Request, bucket: unknown): Promise<Response> => {
    const now = Date.now();

    if (!floodAllowed(request.headers.get("cf-connecting-ip") ?? "unknown", now)) {
        return Response.json({ error: "rate_limited" }, { status: 429 });
    }

    const { method } = request;

    if (method !== "POST" && method !== "PATCH" && method !== "HEAD") {
        return refusal(405, "Method not allowed.", { Allow: "POST, PATCH, HEAD" });
    }

    const header = request.headers.get(HOST_UPLOAD_PAYLOAD_HEADER);
    const signature = request.headers.get(HOST_UPLOAD_SIGNATURE_HEADER);
    const payload = header === null ? null : decodeBase64Url(header);

    // A signature that is not 64 hex characters can belong to no device: refused before any lookup.
    if (payload === null || signature === null || !isDeviceSignature(signature)) {
        return unauthorized();
    }

    const claimed = parseJson(payload);
    const deviceId = isRecord(claimed) ? claimed.deviceId : undefined;

    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > MAX_LENGTH.id) {
        return unauthorized();
    }

    if (!isUploadBucket(bucket) || !context.scheduler) {
        return refusal(503, "Storage is not configured.");
    }

    const ownerId = await deviceOwner(context, deviceId, now);

    if (ownerId === null) {
        return unauthorized();
    }

    const { scheduler } = context;

    return await inShard(context, ownerId, async (shardCtx) => {
        const verified = await shardCtx.runQuery(internal.acp.upload.verifyHostUpload, { deviceId, now, payload, signature });

        // The route said whose device this is; the shard's own device row must agree.
        if (verified?.userId !== ownerId) {
            return unauthorized();
        }

        const post = parseJson(payload);

        if (!isRecord(post) || post.method !== method) {
            return unauthorized();
        }

        const { pathname } = new URL(request.url);
        const bound = method === "POST" ? bindCreate(post, request, pathname) : await bindContinue(post, request, pathname);

        if (bound instanceof Response) {
            return bound;
        }

        if (bound === null) {
            return unauthorized();
        }

        // A replayed create is the same signed bytes again: refused, so a captured one starts no second upload.
        if (
            bound.nonce !== undefined &&
            !(await shardCtx.runMutation(internal.lib.claim_once.claimKey, {
                key: `${deviceId}:${bound.nonce}`,
                scope: HOST_UPLOAD_NONCE_SCOPE,
                ttlMs: NONCE_TTL_MS,
                userId: ownerId,
            }))
        ) {
            return unauthorized();
        }

        return await serveUserUpload({
            allowedTypes: HOST_MEDIA_MIME_TYPES,
            bucket,
            createLimit: "hosts/uploads/create",
            purpose: method === "POST" ? "chat" : undefined,
            request: bound.request,
            scheduler,
            shardCtx,
            userId: ownerId,
        });
    });
};

/**
 * The upload route: the one way file bytes reach storage from outside.
 *
 * Browsers (`/uploads`) and API-key clients (`/api/v1/uploads`) send a file
 * here over TUS — resumable, chunked, with progress — through
 * `@lunora/storage/upload`'s handler over the Worker's own R2 binding (no S3
 * credentials, the same under `lunora dev` as deployed). What lands is a
 * STAGING object (`lib/chat-upload-staging.ts`) that a finalize procedure then
 * checks and takes: `file.finalizeChatUpload`, `vault_functions.saveVaultFile`,
 * `chat_import_functions.startImportJob`. The client keeps only the upload id
 * (the last segment of the TUS upload URL).
 *
 * What this route guarantees, so the finalize steps can rely on it:
 *
 * - **Authenticated.** The caller's identity comes from the request's
 *   credentials as `server.ts` resolved them — never from a URL token. No
 *   identity, 401.
 * - **Server-chosen keys.** The object is named `uploads/<callerId>/<id>` from
 *   the resolved identity and the id the handler generates. Nothing the client
 *   sends reaches the key.
 * - **Per-user upload state.** In-progress state lives under the caller's own
 *   prefix, so a `PATCH`/`HEAD`/`DELETE` naming someone else's upload id finds
 *   nothing (404).
 * - **Purpose, declared on the create.** `POST /uploads?purpose=…` names what
 *   the file is for: `chat` (the default) or `reference-media` (workflow video
 *   and audio, `document-limits.ts`). Any other value is refused (400). The
 *   purpose picks the create's allowlist and size caps, and its key: a
 *   reference-media object is named `uploads/<callerId>/reference-media/<id>`,
 *   so a chat finalize does not address it. Every staged object is also
 *   stamped with its purpose in its R2 custom metadata (`purpose`) when the
 *   object is written, which is lazily, at the first `PATCH` (or at create for
 *   an empty file). The stamp is derived from the key, never from a request.
 *   An object with no stamp is chat, which is what the objects written before
 *   the stamp are. Each finalize step refuses an object stamped for another
 *   purpose, and checks the real bytes against its own allowlist.
 * - **The public API takes no purpose.** `/api/v1/uploads` is chat only, and a
 *   `purpose` there is refused (400) by `refuseDeclaredPurpose`.
 * - **Size caps from the declared type.** A create declaring more than its
 *   purpose's cap for that type, or no size, is refused (413) before a byte is
 *   stored, and no chunk may run past the declared length. Requests that are
 *   not creates are bounded by the length declared at creation, so they carry
 *   no purpose and use the largest cap.
 * - **The MIME allowlist**: a create whose declared type its purpose does not
 *   allow is refused (415). `chat` allows `UPLOAD_ALLOWED_MIME` only.
 * - **Rate limited** per caller on each create: past it, 429 with `Retry-After`.
 * - **Write-only.** The handler refuses `GET` (405); downloads stay on signed
 *   URLs (`lib/signed-storage.ts`).
 *
 * The declared type and size are the CLIENT's word. Finalize re-checks the
 * stored object's real size, type and leading bytes (`takeStagedUpload`).
 */
import type { R2UploadBucket, UploadHandler } from "@lunora/storage/upload";
import { createR2BindingUploadStorage, createUploadHandler } from "@lunora/storage/upload";
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import { UPLOAD_ALLOWED_MIME } from "../vault/lib/file-constants";
import { normalizeContentType, uploadLimitFor } from "./chat-upload";
import type { UploadPurpose } from "./chat-upload-staging";
import { PURPOSE_METADATA_KEY, purposeOfStagingKey, STAGING_PREFIX, STAGING_TTL_MS, stagingKeyFor, uploadStatePrefixFor } from "./chat-upload-staging";
import { inShard } from "./http-shard";
import { MAX_REFERENCE_MEDIA_BYTES, REFERENCE_MEDIA_MIME_TYPES, referenceMediaLimitFor } from "./document-limits";

/** Where browsers upload. The TUS upload URL of each file is `<UPLOAD_PATH>/<uploadId>`. */
export const UPLOAD_PATH = "/uploads";

/** Request headers the TUS client sends, for the CORS preflight. */
export const TUS_REQUEST_HEADERS = ["Tus-Resumable", "Upload-Length", "Upload-Metadata", "Upload-Offset"];

/** Response headers the TUS client reads, for CORS. */
export const TUS_RESPONSE_HEADERS = ["Location", "Tus-Resumable", "Upload-Length", "Upload-Offset", "Upload-Metadata"];

const UPLOAD_PURPOSES: ReadonlySet<string> = new Set(["chat", "reference-media"]);

/** The purpose a create declares in `?purpose=` (absent means chat), or `undefined` for a value that names none. */
const declaredPurpose = (request: Request): UploadPurpose | undefined => {
    const value = new URL(request.url).searchParams.get("purpose") ?? "chat";

    return UPLOAD_PURPOSES.has(value) ? (value as UploadPurpose) : undefined;
};

/** The MIME types a create for `purpose` may declare; a request that is not a create gets the union. */
export const allowedTypesFor = (purpose: UploadPurpose | undefined): ReadonlyArray<string> => {
    if (purpose === "chat") {
        return UPLOAD_ALLOWED_MIME;
    }

    if (purpose === "reference-media") {
        return REFERENCE_MEDIA_MIME_TYPES;
    }

    return [...UPLOAD_ALLOWED_MIME, ...REFERENCE_MEDIA_MIME_TYPES];
};

/** The size cap a create for `purpose` declares a type against. Only creates are capped, so `purpose` is set for them. */
const sizeCapFor = (purpose: UploadPurpose | undefined, contentType: string): number | undefined =>
    purpose === "reference-media" ? referenceMediaLimitFor(contentType) : uploadLimitFor(contentType);

/**
 * The bucket as the provider writes it, with every staged object stamped with
 * its purpose. The provider creates an object lazily and hands the R2 binding
 * only a content type, so the stamp is added here, from the key (which names
 * the purpose at create), on each write that creates an object.
 */
const stampStagedObjects = (bucket: R2UploadBucket): R2UploadBucket =>
    new Proxy(bucket, {
        get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            const stamp = (key: string, options: object | undefined) =>
                key.startsWith(STAGING_PREFIX) ? { ...options, customMetadata: { [PURPOSE_METADATA_KEY]: purposeOfStagingKey(key) } } : options;

            if (property === "createMultipartUpload") {
                return (key: string, options?: object) => target.createMultipartUpload(key, stamp(key, options));
            }

            if (property === "put") {
                return (key: string, body: unknown, options?: object) => target.put(key, body as never, stamp(key, options) as never);
            }

            return typeof value === "function" ? value.bind(target) : value;
        },
    });

export interface UserUploadOptions {
    /** Asked on every request that would create an upload; a response refuses it as is. */
    admitCreate: () => Promise<Response | undefined>;
    /** Narrows the types a create may declare below what its purpose allows (the device route's list). */
    allowedTypes?: ReadonlyArray<string>;
    bucket: R2UploadBucket;
    /** Called with the staging key of every upload created. */
    onCreated: (key: string) => Promise<void>;
    /** The purpose of a create, or `undefined` for a request continuing an upload already created. */
    purpose: UploadPurpose | undefined;
    userId: string;
}

/**
 * The TUS handler for one caller: every key it names, and all the state it
 * keeps, is under that caller's prefixes, and their own `statePrefix` keeps one
 * caller's upload ids from resolving for another. Built per request because
 * `filename` and `onCreate` close over the caller too, so `@lunora/storage`'s
 * per-request `stateScope` would not save the build.
 */
export const createUserUploadHandler = ({ admitCreate, allowedTypes, bucket, onCreated, purpose, userId }: UserUploadOptions): UploadHandler =>
    createUploadHandler({
        authorize: async ({ method }) => method !== "POST" || ((await admitCreate()) ?? true),
        maxFileSize: MAX_REFERENCE_MEDIA_BYTES,
        maxFileSizeFor: ({ contentType }) => sizeCapFor(purpose, normalizeContentType(contentType)),
        storage: createR2BindingUploadStorage(stampStagedObjects(bucket), {
            allowMIME: [...(allowedTypes ?? allowedTypesFor(purpose))],
            filename: (file) => stagingKeyFor(userId, file.id, purpose ?? "chat"),
            onCreate: async (file) => {
                await onCreated(file.name);
            },
            statePrefix: uploadStatePrefixFor(userId),
        }),
    });

/** Whether `value` is an R2 binding with the multipart API — what `env.FILES` is in a Worker and under miniflare. */
export const isUploadBucket = (value: unknown): value is R2UploadBucket =>
    typeof value === "object" &&
    value !== null &&
    "createMultipartUpload" in value &&
    typeof value.createMultipartUpload === "function" &&
    "resumeMultipartUpload" in value &&
    typeof value.resumeMultipartUpload === "function";

export const refusal = (status: number, message: string, headers: Record<string, string> = {}): Response =>
    Response.json({ error: { message } }, { headers: { ...headers, "Tus-Resumable": "1.0.0" }, status });

/**
 * The public API's upload route admits chat uploads only, so a `purpose` there
 * is refused rather than ignored: a reference-media object is not one its
 * finalize can be reached through from that route.
 */
export const refuseDeclaredPurpose = (request: Request): Response | undefined =>
    new URL(request.url).searchParams.has("purpose") ? refusal(400, "The upload purpose cannot be set on the public API.") : undefined;

export interface ServeUploadOptions {
    /** A public API key's scope check; runs first on every request and may refuse it. */
    admit?: (context: HttpActionCtx, request: Request) => Promise<Response | undefined>;
    /** See {@link UserUploadOptions.allowedTypes}. */
    allowedTypes?: ReadonlyArray<string>;
    bucket: R2UploadBucket;
    /** The limit a create is charged to; the device route has its own, apart from the person's. */
    createLimit?: "hosts/uploads/create" | "uploads/create";
    /** The purpose of a create, or `undefined` for a request continuing an upload already created. */
    purpose: UploadPurpose | undefined;
    request: Request;
    scheduler: NonNullable<HttpActionCtx["scheduler"]>;
    /** The caller's shard (`inShard`). */
    shardCtx: HttpActionCtx;
    /** Whoever the request was authenticated as: every key and all state is under this user. */
    userId: string;
}

/**
 * Serve one upload request for `userId` on that user's shard, whoever proved the identity (a session, an API key
 * or a device signature). `admit` runs first on every request; a create is then charged against `createLimit`,
 * and its staging key gets the same reap a finalize would have made moot.
 */
export const serveUserUpload = async ({
    admit,
    allowedTypes,
    bucket,
    createLimit = "uploads/create",
    purpose,
    request,
    scheduler,
    shardCtx,
    userId,
}: ServeUploadOptions): Promise<Response> => {
    const refused = await admit?.(shardCtx, request);

    if (refused) {
        return refused;
    }

    const handler = createUserUploadHandler({
        admitCreate: async () => {
            const limit = await shardCtx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier: userId, key: createLimit });

            return limit.ok
                ? undefined
                : refusal(429, "Too many uploads. Try again shortly.", { "Retry-After": String(Math.max(1, Math.ceil((limit.retryAfter ?? 0) / 1000))) });
        },
        ...(allowedTypes && { allowedTypes }),
        bucket,
        // The reap: if nobody finalizes this upload, its object is deleted
        // after the TTL. A finalized (or never-finished) one makes it a no-op.
        onCreated: async (key) => {
            await scheduler.runAfter(STAGING_TTL_MS, internal.lib.storage_cleanup.deleteObjects, { keys: [key] });
        },
        purpose,
        userId,
    });

    return await handler.fetch(request);
};

/**
 * Serve one upload request for whoever `context.auth` resolved, on that
 * caller's shard. `admit` runs first on every request (a public API key's
 * scope check); a create is then charged against `uploads/create`, and its
 * staging key gets the same reap a finalize would have made moot.
 */
export const handleUploadRequest = async (
    context: HttpActionCtx,
    request: Request,
    bucket: unknown,
    admit: (context: HttpActionCtx, request: Request) => Promise<Response | undefined> = async () => undefined,
): Promise<Response> => {
    const { userId } = context.auth;

    if (!userId) {
        return refusal(401, "Authentication required.");
    }

    const creating = request.method === "POST";
    // Only the create names the object (and so its purpose): the provider keeps that name in the upload's state, and
    // PATCH/HEAD/DELETE address the upload by id, so a continuation writes to the key chosen here. The test
    // "a reference-media upload, from its create to finalize" drives the real handler through PATCH to prove it.
    const purpose = creating ? declaredPurpose(request) : undefined;

    if (creating && purpose === undefined) {
        return refusal(400, "Unknown upload purpose.");
    }

    if (!isUploadBucket(bucket) || !context.scheduler) {
        return refusal(503, "Storage is not configured.");
    }

    const { scheduler } = context;

    return await inShard(context, userId, async (shardCtx) => await serveUserUpload({ admit, bucket, purpose, request, scheduler, shardCtx, userId }));
};

export { type UploadPurpose } from "./chat-upload-staging";

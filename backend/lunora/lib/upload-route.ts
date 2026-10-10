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
 * - **Size caps from the declared type.** A create declaring more than its
 *   type's chat limit (`uploadLimitFor`), or no size, is refused (413) before a
 *   byte is stored, and no chunk may run past the declared length.
 * - **The MIME allowlist** (`UPLOAD_ALLOWED_MIME`): any other declared type is
 *   refused (415).
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
import { FINALIZE_MAX_BYTES, normalizeContentType, uploadLimitFor } from "./chat-upload";
import { STAGING_TTL_MS, stagingKeyFor, uploadStatePrefixFor } from "./chat-upload-staging";
import { inShard } from "./http-shard";

/** Where browsers upload. The TUS upload URL of each file is `<UPLOAD_PATH>/<uploadId>`. */
export const UPLOAD_PATH = "/uploads";

/** Request headers the TUS client sends, for the CORS preflight. */
export const TUS_REQUEST_HEADERS = ["Tus-Resumable", "Upload-Length", "Upload-Metadata", "Upload-Offset"];

/** Response headers the TUS client reads, for CORS. */
export const TUS_RESPONSE_HEADERS = ["Location", "Tus-Resumable", "Upload-Length", "Upload-Offset", "Upload-Metadata"];

export interface UserUploadOptions {
    /** Asked on every request that would create an upload; a response refuses it as is. */
    admitCreate: () => Promise<Response | undefined>;
    bucket: R2UploadBucket;
    /** Called with the staging key of every upload created. */
    onCreated: (key: string) => Promise<void>;
    userId: string;
}

/**
 * The TUS handler for one caller: every key it names, and all the state it
 * keeps, is under that caller's prefixes, and their own `statePrefix` keeps one
 * caller's upload ids from resolving for another. Built per request because
 * `filename` and `onCreate` close over the caller too, so `@lunora/storage`'s
 * per-request `stateScope` would not save the build.
 */
export const createUserUploadHandler = ({ admitCreate, bucket, onCreated, userId }: UserUploadOptions): UploadHandler =>
    createUploadHandler({
        authorize: async ({ method }) => method !== "POST" || ((await admitCreate()) ?? true),
        maxFileSize: FINALIZE_MAX_BYTES,
        maxFileSizeFor: ({ contentType }) => uploadLimitFor(normalizeContentType(contentType)),
        storage: createR2BindingUploadStorage(bucket, {
            allowMIME: [...UPLOAD_ALLOWED_MIME],
            filename: (file) => stagingKeyFor(userId, file.id),
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

const refusal = (status: number, message: string, headers: Record<string, string> = {}): Response =>
    Response.json({ error: { message } }, { headers: { ...headers, "Tus-Resumable": "1.0.0" }, status });

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

    if (!isUploadBucket(bucket) || !context.scheduler) {
        return refusal(503, "Storage is not configured.");
    }

    const { scheduler } = context;

    return await inShard(context, userId, async (shardCtx) => {
        const refused = await admit(shardCtx, request);

        if (refused) {
            return refused;
        }

        const handler = createUserUploadHandler({
            admitCreate: async () => {
                const limit = await shardCtx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier: userId, key: "uploads/create" });

                return limit.ok
                    ? undefined
                    : refusal(429, "Too many uploads. Try again shortly.", { "Retry-After": String(Math.max(1, Math.ceil((limit.retryAfter ?? 0) / 1000))) });
            },
            bucket,
            // The reap: if nobody finalizes this upload, its object is deleted
            // after the TTL. A finalized (or never-finished) one makes it a no-op.
            onCreated: async (key) => {
                await scheduler.runAfter(STAGING_TTL_MS, internal.lib.storage_cleanup.deleteObjects, { keys: [key] });
            },
            userId,
        });

        return await handler.fetch(request);
    });
};

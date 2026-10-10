/**
 * What happens to a staged upload (`lib/chat-upload-staging.ts`) once the
 * browser has sent its bytes: {@link takeStagedUpload} checks it and hands it to
 * the caller's finalize step, and {@link purgeStagedUploads} mops up what was
 * never finalized. Written against the narrow slice of an action context each
 * step needs, so it is testable without a Worker (`chat-upload.test.ts`).
 *
 * See `file.ts` for the chat attachment flow and `lib/upload-route.ts` for how
 * the bytes arrive.
 */
import { LunoraError } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { storeFile } from "../agent/client";
import { CHAT_UPLOAD_CONTENT_MISMATCH, CHAT_UPLOAD_EXPIRED, CHAT_UPLOAD_TOO_LARGE, CHAT_UPLOAD_UNSUPPORTED_TYPE } from "./chat-upload-codes";
import { isUploadId, STAGING_TTL_MS, stagingKeyFor, stagingPrefixFor, uploadStatePrefixFor } from "./chat-upload-staging";
import { contentMatchesType, SNIFF_BYTES } from "./content-sniff";
import { chatAttachmentLimit, MAX_EXTRACTION_DOCUMENT_BYTES } from "./document-limits";
import { storageLogger } from "./logger";
import { isServiceBound } from "./services";
import { UPLOAD_ALLOWED_MIME } from "../vault/lib/file-constants";

const MEGABYTE = 1024 * 1024;

/**
 * The most finalize reads into memory. Finalize hashes and re-stores the
 * object from one buffer, so this is a memory ceiling as much as a size cap.
 * It equals the largest per-kind limit of any type the allowlist accepts —
 * documents, 25 MB (images are 20 MB; audio and video are not on the
 * allowlist). Accepting video would need a streaming hash and copy here.
 */
export const FINALIZE_MAX_BYTES = MAX_EXTRACTION_DOCUMENT_BYTES;

/** Staging objects one housekeeping purge lists per page. */
const PURGE_LIST_LIMIT = 100;
/** Listing pages one purge walks; a backlog past that waits for the next sweep. */
const PURGE_MAX_PAGES = 10;

export const normalizeContentType = (contentType: string): string => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const isAllowedType = (contentType: string): boolean => (UPLOAD_ALLOWED_MIME as ReadonlyArray<string>).includes(contentType);

/** The cap for `contentType`: its per-kind chat limit, never above what finalize can hold. */
export const uploadLimitFor = (contentType: string): number => Math.min(chatAttachmentLimit(contentType).maxBytes, FINALIZE_MAX_BYTES);

const tooLarge = (maxBytes: number): LunoraError =>
    new LunoraError("PAYLOAD_TOO_LARGE", `Files of this type can be at most ${String(Math.floor(maxBytes / MEGABYTE))} MB.`, {
        data: { code: CHAT_UPLOAD_TOO_LARGE, maxBytes },
    });

const unsupportedType = (): LunoraError =>
    new LunoraError("BAD_REQUEST", "This file type cannot be attached.", { data: { code: CHAT_UPLOAD_UNSUPPORTED_TYPE } });

const expired = (): LunoraError =>
    new LunoraError("NOT_FOUND", "The upload expired or was never completed. Please attach the file again.", { data: { code: CHAT_UPLOAD_EXPIRED } });

const empty = (): LunoraError => new LunoraError("BAD_REQUEST", "The file is empty.");

/** A staged upload that passed every check, as {@link takeStagedUpload} hands it on. */
export interface StagedUpload {
    bytes: ArrayBuffer;
    contentType: string;
}

/**
 * Read what actually arrived under `userId`'s staging key for `uploadId`, check
 * its real size (`maxBytesFor` its stored type), its type against the
 * allowlist and its leading bytes, and hand it to `use`. The staging object is
 * deleted whatever the outcome, once it has been looked at.
 *
 * The size and type the upload route checked were the browser's DECLARATION;
 * this is the check on the bytes. Another user's upload is not addressable at
 * all — the key is rebuilt from `userId` — so it answers exactly like a missing
 * one.
 */
export const takeStagedUpload = async <T>(
    ctx: Pick<ActionCtx, "storage">,
    userId: string,
    uploadId: string,
    maxBytesFor: (contentType: string) => number,
    use: (upload: StagedUpload) => Promise<T>,
): Promise<T> => {
    if (!isUploadId(uploadId)) {
        throw expired();
    }

    const key = stagingKeyFor(userId, uploadId);
    const object = await ctx.storage.download(key);

    if (!object) {
        throw expired();
    }

    try {
        const contentType = normalizeContentType(object.httpMetadata?.contentType ?? "");

        if (!isAllowedType(contentType)) {
            await object.body?.cancel();

            throw unsupportedType();
        }

        const maxBytes = maxBytesFor(contentType);

        if (object.size > maxBytes) {
            await object.body?.cancel();

            throw tooLarge(maxBytes);
        }

        const bytes = object.body ? await new Response(object.body).arrayBuffer() : new ArrayBuffer(0);

        // `size` is R2's word; the bytes are the truth.
        if (bytes.byteLength > maxBytes) {
            throw tooLarge(maxBytes);
        }

        if (bytes.byteLength === 0) {
            throw empty();
        }

        if (!contentMatchesType(new Uint8Array(bytes, 0, Math.min(SNIFF_BYTES, bytes.byteLength)), contentType)) {
            throw new LunoraError("BAD_REQUEST", "The file's contents do not match its type.", { data: { code: CHAT_UPLOAD_CONTENT_MISMATCH } });
        }

        return await use({ bytes, contentType });
    } finally {
        await ctx.storage.delete(key).catch((error: unknown) => {
            storageLogger.warn(`Failed to delete staged upload ${key}`, error);
        });
    }
};

/**
 * Turn `userId`'s staged `uploadId` into a chat file: stored content-addressed
 * with a grant for `userId`, and queued for text extraction.
 */
export const finalizeStagedUpload = async (
    ctx: ActionCtx,
    userId: string,
    args: { filename: string; uploadId: string },
): Promise<{ fileId: Id<"chatFiles">; url: string }> =>
    await takeStagedUpload(ctx, userId, args.uploadId, uploadLimitFor, async ({ bytes, contentType }) => {
        const maxBytes = uploadLimitFor(contentType);
        const {
            file: { fileId, storageId, url },
        } = await storeFile(
            ctx,
            { bytes, type: contentType },
            {
                allowedContentTypes: UPLOAD_ALLOWED_MIME,
                filename: args.filename,
                maxSize: maxBytes,
                // The uploader's grant: what lets them attach this file to a message.
                userId,
            },
        );

        // Text extraction runs in the background via the document-parser Worker.
        if (isServiceBound(ctx, "documentParser")) {
            await ctx.scheduler.runAfter(0, internal.agent.extraction.extractDocumentText, {
                fileId: fileId as Id<"chatFiles">,
                mediaType: contentType,
                storageId,
            });
        }

        return { fileId: fileId as Id<"chatFiles">, url };
    });

/** The keys under `prefix` last written before `cutoff`, at most {@link PURGE_MAX_PAGES} pages of them. */
const staleKeys = async (storage: Pick<ActionCtx["storage"], "list">, prefix: string, cutoff: number): Promise<string[]> => {
    const stale: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < PURGE_MAX_PAGES; page += 1) {
        const listing = await storage.list(prefix, { limit: PURGE_LIST_LIMIT, ...(cursor && { cursor }) });

        // An object with no upload time counts as old: the per-key reap is the
        // precise path, this one only mops up.
        stale.push(...listing.objects.filter((object) => object.uploaded === undefined || object.uploaded.getTime() < cutoff).map((object) => object.key));

        if (!listing.truncated || !listing.cursor) {
            break;
        }

        cursor = listing.cursor;
    }

    return stale;
};

/**
 * Deletes `userId`'s staging objects uploaded before `now - STAGING_TTL_MS`,
 * and the state of uploads untouched for as long — abandoned midway, so they
 * never produced a staging object for the per-key reap to find. Every write to
 * an upload rewrites its state object, so a live upload is never that old.
 */
export const purgeStagedUploads = async (storage: Pick<ActionCtx["storage"], "delete" | "list">, userId: string, now: number): Promise<number> => {
    const cutoff = now - STAGING_TTL_MS;
    const stale = [...(await staleKeys(storage, stagingPrefixFor(userId), cutoff)), ...(await staleKeys(storage, uploadStatePrefixFor(userId), cutoff))];
    let deleted = 0;

    for (const key of stale) {
        try {
            await storage.delete(key);
            deleted += 1;
        } catch (error) {
            storageLogger.warn(`Failed to purge staged upload ${key}`, error);
        }
    }

    return deleted;
};

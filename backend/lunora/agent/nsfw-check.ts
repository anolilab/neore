/**
 * NSFW image classification — calls the nsfw-checker Cloudflare Worker
 * to classify images for explicit content.
 *
 * Flow:
 *   1. `storeFile` / vault upload stores image
 *   2. Scheduler triggers `checkImageNsfwForChatFile` or `checkImageNsfwForVaultFile`
 *   3. This action fetches image bytes and sends them to the nsfw-checker Worker
 *   4. Classification result is saved back to the chatFiles / files table
 */
import { classifyImage, createNsfwCheckerClient, type NsfwResponse } from "@neore/service-sdk/nsfw-checker";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { FETCH_TIMEOUT_MS } from "../lib/fetch-timeout";
import { isServiceBound, type ServiceFetch, serviceFetch } from "../lib/services";
import { MAX_STORED_READ_BYTES, readStoredObject } from "../lib/storage-read";

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/gif", "image/jpeg", "image/jpg", "image/png", "image/tiff", "image/webp"]);

const isImageMimeType = (mimeType: string): boolean => mimeType.startsWith("image/") || IMAGE_MIME_TYPES.has(mimeType);

interface NsfwScores {
    drawing: number;
    hentai: number;
    neutral: number;
    porn: number;
    sexy: number;
}

interface NsfwClassifyResult {
    isNsfw: boolean;
    scores: NsfwScores;
}

/**
 * Classify image bytes via the nsfw-checker SDK.
 */
const classifyImageBytes = async (fileBytes: ArrayBuffer, mediaType: string, checker: ServiceFetch): Promise<NsfwClassifyResult> => {
    const client = createNsfwCheckerClient({ fetch: checker });

    const { data, error, response } = await classifyImage({
        body: new Blob([fileBytes], { type: mediaType }),
        client,
        headers: { "content-type": mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // `response` is absent when the request never completed (DNS, connect, abort).
    if (error || !response?.ok || !data) {
        throw new Error(`NSFW checker returned ${response?.status ?? "no response"}: ${JSON.stringify(error)}`);
    }

    const result = data as unknown as NsfwResponse;

    return {
        isNsfw: result.isNsfw,
        scores: {
            drawing: result.drawing,
            hentai: result.hentai,
            neutral: result.neutral,
            porn: result.porn,
            sexy: result.sexy,
        },
    };
};

export const checkImageNsfwForChatFile = internalAction
    .input({
        fileId: v.id("chatFiles"),
        mediaType: v.string(),
        storageId: v.string(),
    })
    .action(async ({ args, ctx }) => {
        if (!isServiceBound(ctx, "nsfwChecker")) {
            console.warn("nsfw-checker service binding (SERVICE_NSFW_CHECKER) not bound — skipping NSFW check");

            return;
        }

        if (!isImageMimeType(args.mediaType)) {
            return;
        }

        await ctx.runMutation(internal.agent.files.markNsfwChecking, {
            fileId: args.fileId,
        });

        try {
            // Through the binding, not over HTTP: `getUrl` is an unsigned URL that
            // nothing serves, and user files are not public (`lib/storage-read.ts`).
            const { bytes: fileBytes } = await readStoredObject(ctx.storage, args.storageId as string, { maxBytes: MAX_STORED_READ_BYTES });
            const { isNsfw, scores } = await classifyImageBytes(fileBytes, args.mediaType, serviceFetch(ctx, "nsfwChecker"));

            await ctx.runMutation(internal.agent.files.saveNsfwResult, {
                fileId: args.fileId,
                isNsfw,
                scores,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown NSFW check error";

            console.error(`NSFW check failed for chat file ${args.fileId}:`, message);

            await ctx.runMutation(internal.agent.files.markNsfwFailed, {
                fileId: args.fileId,
            });
        }
    });

export const checkImageNsfwForVaultFile = internalAction
    .input({
        fileId: v.id("files"),
        mediaType: v.string(),
        r2Key: v.string(),
    })
    .action(async ({ args, ctx }) => {
        if (!isServiceBound(ctx, "nsfwChecker")) {
            console.warn("nsfw-checker service binding (SERVICE_NSFW_CHECKER) not bound — skipping NSFW check");

            return;
        }

        if (!isImageMimeType(args.mediaType)) {
            return;
        }

        await ctx.runMutation(internal.vault.functions.markNsfwChecking, {
            fileId: args.fileId,
        });

        try {
            const { bytes: fileBytes } = await readStoredObject(ctx.storage, args.r2Key, { maxBytes: MAX_STORED_READ_BYTES });
            const { isNsfw, scores } = await classifyImageBytes(fileBytes, args.mediaType, serviceFetch(ctx, "nsfwChecker"));

            await ctx.runMutation(internal.vault.functions.saveNsfwResult, {
                fileId: args.fileId,
                isNsfw,
                scores,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown NSFW check error";

            console.error(`NSFW check failed for vault file ${args.fileId}:`, message);

            await ctx.runMutation(internal.vault.functions.markNsfwFailed, {
                fileId: args.fileId,
            });
        }
    });

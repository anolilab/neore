/**
 * Feedback a user sends from the app ("Send feedback" in the user menu).
 *
 * The images arrive over the upload route like any chat attachment
 * (`lib/upload-route.ts`); {@link submitFeedback} takes each staged upload by
 * id, checks its real bytes (`takeStagedUpload`), keeps only still images and
 * stores them under `feedback/<userId>/`. The row goes in last: when anything
 * fails, the images already stored are deleted again, so no object is left
 * without a row pointing at it.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { takeStagedUpload } from "../lib/chat-upload";
import { authAction, rateLimit } from "../lib/crpc";
import { withDependency } from "../lib/dependency";
import { withoutUndefined } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";
import { FEEDBACK_IMAGE_TYPES, MAX_FEEDBACK_IMAGE_BYTES, MAX_FEEDBACK_IMAGES, MAX_FEEDBACK_MESSAGE_LENGTH } from "./limits";
import { vFeedbackKind } from "./validators";

const vStoredImage = v.object({ contentType: v.string(), key: v.string(), size: v.number() });

export const submitFeedback = authAction
    .input({
        kind: vFeedbackKind,
        message: v.string().max(MAX_FEEDBACK_MESSAGE_LENGTH),
        pagePath: v.optional(v.string().max(MAX_LENGTH.short)),
        uploadIds: v.array(v.string().max(MAX_LENGTH.id)).max(MAX_FEEDBACK_IMAGES),
    })
    .use(rateLimit("feedback/submit"))
    .output(v.object({ feedbackId: v.id("feedback") }))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const message = args.message.trim();

        if (message.length === 0) {
            throw new LunoraError("BAD_REQUEST", "Write a few words before sending.");
        }

        const images: { contentType: string; key: string; size: number }[] = [];

        try {
            for (const uploadId of args.uploadIds) {
                const image = await takeStagedUpload(
                    ctx,
                    userId,
                    uploadId,
                    () => MAX_FEEDBACK_IMAGE_BYTES,
                    async ({ bytes, contentType }) => {
                        if (!FEEDBACK_IMAGE_TYPES.includes(contentType)) {
                            throw new LunoraError("BAD_REQUEST", "Only PNG, JPEG, WebP and GIF images can be attached to feedback.");
                        }

                        const key = `feedback/${userId}/${crypto.randomUUID()}`;

                        await withDependency("file storage", () =>
                            ctx.storage.store(key, bytes, { allowedContentTypes: [...FEEDBACK_IMAGE_TYPES], contentType, maxSize: MAX_FEEDBACK_IMAGE_BYTES }),
                        );

                        return { contentType, key, size: bytes.byteLength };
                    },
                );

                images.push(image);
            }

            const feedbackId = await ctx.runMutation(internal.feedback.functions.insertFeedback, {
                images,
                kind: args.kind,
                message,
                pagePath: args.pagePath?.trim() || undefined,
                userId,
            });

            ctx.log.event("feedback.submitted", { imageCount: images.length, kind: args.kind });

            return { feedbackId };
        } catch (error) {
            // No row, no reference: an image stored before the failure would be unreachable.
            await Promise.all(images.map(async ({ key }) => await ctx.storage.delete(key).catch(() => undefined)));

            throw error;
        }
    });

/** The row of the feedback {@link submitFeedback} just stored the images of. */
export const insertFeedback = internalMutation
    .input({
        images: v.array(vStoredImage),
        kind: vFeedbackKind,
        message: v.string(),
        pagePath: v.optional(v.string()),
        userId: v.string(),
    })
    .output(v.id("feedback"))
    .mutation(async ({ args, ctx }) => await ctx.db.insert("feedback", withoutUndefined({ ...args, createdAt: Date.now() })));

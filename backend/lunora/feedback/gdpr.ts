/**
 * The feedback module's erasure and export. Erasure is called from
 * `gdpr/steps/residual-deletion-steps.ts#deleteUserIntegrations`; the export
 * reads a page at a time from `gdpr/steps.ts#generateExportFile`.
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { MAX_LENGTH } from "../lib/validators";
import { vFeedbackKind } from "./validators";

/** A batch of the user's feedback with its images. */
export const eraseFeedbackForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: rows } = await ctx.db.feedback.findMany({ limit: BATCH, where: { userId } });

    await scheduleObjectDeletion(
        ctx,
        rows.flatMap((row) => row.images.map((image) => image.key)),
    );

    for (const row of rows) {
        await ctx.db.delete("feedback", row._id);
    }

    return { hasMore: full(rows) };
};

/** One page of the user's feedback for the GDPR export, oldest first. The images are listed by type and size. */
export const collectFeedbackForExport = internalQuery
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.cursor)), userId: v.string() })
    .output(
        v.object({
            continueCursor: v.optional(v.string()),
            feedback: v.array(
                v.object({
                    createdAt: v.number(),
                    images: v.array(v.object({ contentType: v.string(), size: v.number() })),
                    kind: vFeedbackKind,
                    message: v.string(),
                    pagePath: v.optional(v.string()),
                }),
            ),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db.feedback.findMany({ cursor, limit: BATCH, orderBy: [{ createdAt: "asc" }], where: { userId } });

        return {
            continueCursor: page.isDone ? undefined : (page.continueCursor ?? undefined),
            feedback: page.page.map((row) => {
                return {
                    createdAt: row.createdAt,
                    images: row.images.map(({ contentType, size }) => {
                        return { contentType, size };
                    }),
                    kind: row.kind,
                    message: row.message,
                    pagePath: row.pagePath,
                };
            }),
        };
    });

/**
 * The most the export reads of the user's feedback, out of the action's shared read budget (`gdpr/read-budget.ts`).
 * Past it the feedback is marked as cut, never dropped silently; a page of up to {@link BATCH} rows may run over it.
 */
export const FEEDBACK_READ_BYTES = 4 * 1024 * 1024;

type FeedbackExportPage = { continueCursor?: string; feedback: unknown[] };

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Every page of the user's feedback, read through `readPage` until the last one or `maxBytes` read. */
export const collectAllFeedback = async (
    readPage: (cursor: string | undefined) => Promise<FeedbackExportPage>,
    maxBytes: number = FEEDBACK_READ_BYTES,
): Promise<{ readBytes: number; section: { feedback: unknown[]; truncated: boolean } }> => {
    const feedback: unknown[] = [];
    let cursor: string | undefined;
    let readBytes = 0;

    do {
        const page = await readPage(cursor);

        feedback.push(...page.feedback);
        readBytes += bytesOf(page.feedback);
        cursor = page.continueCursor;
    } while (cursor !== undefined && readBytes < maxBytes);

    return { readBytes, section: { feedback, truncated: cursor !== undefined } };
};

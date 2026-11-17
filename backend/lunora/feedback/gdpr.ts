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

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

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

/**
 * One page of the user's feedback for the GDPR export, oldest first. The images are listed by type and size.
 * `readBytes` is what reading the page cost: the whole rows, image keys included, not the smaller rows it returns.
 */
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
            readBytes: v.number(),
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
            readBytes: page.page.reduce((total, row) => total + bytesOf(row), 0),
        };
    });

type FeedbackExportPage = { continueCursor?: string; feedback: unknown[]; readBytes: number };

/**
 * Every page of the user's feedback, read through `readPage` until the last one or `maxBytes` read (its share of the
 * action's read budget, `gdpr/read-budget.ts#feedbackReadBudget`). Past it the feedback is marked as cut, never dropped
 * silently; with no budget left nothing is read. A page of up to {@link BATCH} rows may run over it.
 */
export const collectAllFeedback = async (
    readPage: (cursor: string | undefined) => Promise<FeedbackExportPage>,
    maxBytes: number,
): Promise<{ readBytes: number; section: { feedback: unknown[]; truncated: boolean } }> => {
    const feedback: unknown[] = [];
    let cursor: string | undefined;
    let done = false;
    let readBytes = 0;

    while (!done && readBytes < maxBytes) {
        const page = await readPage(cursor);

        feedback.push(...page.feedback);
        readBytes += page.readBytes;
        cursor = page.continueCursor;
        done = cursor === undefined;
    }

    return { readBytes, section: { feedback, truncated: !done } };
};

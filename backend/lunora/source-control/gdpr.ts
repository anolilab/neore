/**
 * Review drafts in the GDPR export and account deletion.
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-review-drafts") and
 * `gdpr/workflows/deletion-workflow.ts` ("delete-user-review-drafts"). Deletion
 * follows the residual steps' contract (`gdpr/steps/residual-deletion-steps.ts`):
 * at most `BATCH` rows per call, `{ hasMore }` back, idempotent on retry. Draft
 * text is the user's own writing about someone else's code, so it travels with the
 * export; nothing the host sent us is stored.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { vDraftComment, vReviewVerdict } from "./validators";

const BATCH = 100;

/** A draft is one per pull request; the export reads this many at most, like the other collectors' ceilings. */
const EXPORT_MAX = 1000;

export const collectReviewDraftsForExport = internalQuery
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            drafts: v.array(
                v.object({
                    body: v.string(),
                    comments: v.array(vDraftComment),
                    commitId: v.string(),
                    createdAt: v.number(),
                    hostOrigin: v.string(),
                    number: v.number(),
                    repository: v.string(),
                    updatedAt: v.number(),
                    verdict: v.union(vReviewVerdict, v.null()),
                }),
            ),
        }),
    )
    .query(async ({ args: { userId }, ctx }) => {
        const drafts = await ctx.db
            .query("reviewDrafts")
            .withIndex("by_user_and_pull", (q) => q.eq("userId", userId))
            .take(EXPORT_MAX);

        return {
            drafts: drafts.map((draft) => {
                return {
                    body: draft.body,
                    comments: draft.comments,
                    commitId: draft.commitId,
                    createdAt: draft.createdAt,
                    hostOrigin: draft.hostOrigin,
                    number: draft.number,
                    repository: draft.repository,
                    updatedAt: draft.updatedAt,
                    verdict: draft.verdict,
                };
            }),
        };
    });

export const deleteUserReviewDrafts = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const drafts = await ctx.db
            .query("reviewDrafts")
            .withIndex("by_user_and_pull", (q) => q.eq("userId", userId))
            .take(BATCH);

        await Promise.all(drafts.map((draft) => ctx.db.delete(draft._id)));

        return { hasMore: drafts.length >= BATCH };
    });

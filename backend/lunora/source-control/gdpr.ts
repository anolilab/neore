/**
 * Review drafts and pull-request/thread links in the GDPR export and account deletion.
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-review-drafts") and
 * `gdpr/workflows/deletion-workflow.ts` ("delete-user-review-drafts",
 * "delete-user-pull-request-threads"). Deletion follows the residual steps' contract
 * (`gdpr/steps/residual-deletion-steps.ts`): at most `BATCH` rows per call, `{ hasMore }` back,
 * idempotent on retry. Draft text is the user's own writing about someone else's code, so it
 * travels with the export; nothing the host sent us is stored. The links hold no content of
 * theirs, so they are erased and not exported.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { vDraftComment, vReviewVerdict } from "./validators";

const BATCH = 100;

/** Drafts per export step: the workflow persists each step's result, so a page stays small and a long history takes more steps. */
const EXPORT_PAGE = 50;

export const collectReviewDraftsForExport = internalQuery
    .input({ cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
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
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db
            .query("reviewDrafts")
            .withIndex("by_user_and_pull", (q) => q.eq("userId", userId))
            .paginate({ cursor: cursor ?? null, numItems: EXPORT_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            drafts: page.page.map((draft) => {
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

/**
 * The links between a user's threads and the pull requests they work on. Nothing here is content of theirs — a
 * repository address, a number, a title the server built — so it is erased, not exported.
 */
export const deleteUserPullRequestThreads = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const links = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId))
            .take(BATCH);

        await Promise.all(links.map((link) => ctx.db.delete(link._id)));

        return { hasMore: links.length >= BATCH };
    });

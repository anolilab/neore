/**
 * Review drafts and watched repositories in the GDPR export and account deletion.
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-review-drafts") and
 * `gdpr/workflows/deletion-workflow.ts` ("delete-user-review-drafts"). Deletion
 * follows the residual steps' contract (`gdpr/steps/residual-deletion-steps.ts`):
 * at most `BATCH` rows per call, `{ hasMore }` back, idempotent on retry. Draft
 * text is the user's own writing about someone else's code, so it travels with the
 * export. Of what the host sent us, the only thing stored is a watched repository's cached list of requests that ask
 * the user for a review (title, author, link): the user's own watch list and that cache travel with the export too,
 * and the repository webhook secret (encrypted) does not. Deletion wipes both; the webhook's shard route goes with
 * the owner's other routes (`deleteShardRoutesOf`), and its replay claims are tagged with the user.
 *
 * Both are wired the same way; watched repositories at most `MAX_WATCHED_REPOSITORIES` rows, so one export step.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { MAX_WATCHED_REPOSITORIES } from "./freshness-logic";
import { vCachedRequest, vDraftComment, vPollStatus, vReviewVerdict } from "./validators";

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

export const collectWatchedRepositoriesForExport = internalQuery
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            watched: v.array(
                v.object({
                    createdAt: v.number(),
                    hostOrigin: v.string(),
                    lastStatus: vPollStatus,
                    repository: v.string(),
                    requested: v.array(vCachedRequest),
                    webhookEnabled: v.boolean(),
                }),
            ),
        }),
    )
    .query(async ({ args: { userId }, ctx }) => {
        const rows = await ctx.db
            .query("watchedRepositories")
            .withIndex("by_user_and_repository", (q) => q.eq("userId", userId))
            .take(MAX_WATCHED_REPOSITORIES + 1);

        return {
            watched: rows.map((row) => {
                return {
                    createdAt: row.createdAt,
                    hostOrigin: row.hostOrigin,
                    lastStatus: row.lastStatus,
                    repository: row.repository,
                    requested: row.requested,
                    webhookEnabled: row.webhookSecret !== undefined,
                };
            }),
        };
    });

export const deleteUserWatchedRepositories = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const rows = await ctx.db
            .query("watchedRepositories")
            .withIndex("by_user_and_repository", (q) => q.eq("userId", userId))
            .take(BATCH);

        await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

        return { hasMore: rows.length >= BATCH };
    });

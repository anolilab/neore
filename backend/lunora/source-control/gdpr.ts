/**
 * Review drafts, AI guides, watched repositories and pull-request/thread links in the GDPR export and account deletion.
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
 * The pull-request/thread links (`collectPullRequestThreadsForExport`, `deleteUserPullRequestThreads`) are paged in the export and
 * erased in batches. Both are wired the same way; watched repositories at most `MAX_WATCHED_REPOSITORIES` rows, so one export step.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { MAX_WATCHED_REPOSITORIES } from "./freshness-logic";
import { vCachedRequest, vDraftComment, vGuideProposal, vGuideSource, vGuideStatus, vGuideStop, vPollStatus, vReviewVerdict } from "./validators";

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

/** Guides per export step: each is persisted as a workflow step result, and a guide of a large pull request is big. */
const GUIDE_EXPORT_PAGE = 3;

/** The user's guides: their instructions, and what was written about code they reviewed. */
export const collectGuidesForExport = internalQuery
    .input({ cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            guides: v.array(
                v.object({
                    createdAt: v.number(),
                    generatedAt: v.number(),
                    headSha: v.string(),
                    hostOrigin: v.string(),
                    instructions: v.string(),
                    number: v.number(),
                    proposals: v.array(vGuideProposal),
                    repository: v.string(),
                    source: vGuideSource,
                    status: vGuideStatus,
                    stops: v.array(vGuideStop),
                    summary: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db
            .query("pullRequestGuides")
            .withIndex("by_user_and_pull", (q) => q.eq("userId", userId))
            .paginate({ cursor: cursor ?? null, numItems: GUIDE_EXPORT_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            guides: page.page.map((guide) => {
                return {
                    createdAt: guide.createdAt,
                    generatedAt: guide.generatedAt,
                    headSha: guide.headSha,
                    hostOrigin: guide.hostOrigin,
                    instructions: guide.instructions,
                    number: guide.number,
                    proposals: guide.proposals,
                    repository: guide.repository,
                    source: guide.source,
                    status: guide.status,
                    stops: guide.stops,
                    summary: guide.summary,
                };
            }),
        };
    });

export const deleteUserGuides = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const guides = await ctx.db
            .query("pullRequestGuides")
            .withIndex("by_user_and_pull", (q) => q.eq("userId", userId))
            .take(BATCH);

        await Promise.all(guides.map((guide) => ctx.db.delete(guide._id)));

        return { hasMore: guides.length >= BATCH };
    });

/** Links per export step: each row is small, so a page is generous and a long history still takes few steps. */
const PULL_REQUEST_LINKS_EXPORT_PAGE = 100;

/**
 * The user's links between threads and the pull requests they work on. `title` is a copy of the thread's title when
 * the link was made (the user's own words, and it outlives a rename or a deletion), so the links travel with the export.
 */
export const collectPullRequestThreadsForExport = internalQuery
    .input({ cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            links: v.array(
                v.object({
                    baseBranch: v.optional(v.string()),
                    createdAt: v.number(),
                    headBranch: v.optional(v.string()),
                    kind: v.union(v.literal("attached"), v.literal("opened")),
                    number: v.number(),
                    repository: v.string(),
                    threadId: v.string(),
                    title: v.string(),
                    url: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId))
            .paginate({ cursor: cursor ?? null, numItems: PULL_REQUEST_LINKS_EXPORT_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            links: page.page.map((link) => {
                return {
                    ...(link.baseBranch !== undefined && { baseBranch: link.baseBranch }),
                    createdAt: link.createdAt,
                    ...(link.headBranch !== undefined && { headBranch: link.headBranch }),
                    kind: link.kind,
                    number: link.number,
                    repository: link.repository,
                    threadId: link.threadId,
                    title: link.title,
                    url: link.url,
                };
            }),
        };
    });

/** Erased on account deletion, batch by batch. */
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

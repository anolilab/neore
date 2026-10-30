/**
 * Develop mode, review side: the host calls of a review. Every procedure is an
 * ACTION (an external call never belongs in a query or mutation) and every host
 * write is something the user just asked for: nothing here runs on its own.
 *
 * - The review conversation and the viewed marks are READ from the host.
 * - A reply, a resolve and a viewed mark are written at once, as the user does them.
 * - The review itself is the draft in `review-drafts.ts`, posted by `submitReview`
 *   as one host call, and the draft goes only after the host confirmed it.
 *
 * The token is decrypted inside the action, used for the call and never returned.
 * A host that refuses a write is a `status` carrying its reason, not a throw.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import { readFromHost } from "./read-host";
import { submitDraft } from "./submit-review";
import { vDiffSide, vFailed, vWriteFailed } from "./validators";
import { writeToHost } from "./write-host";

const vThreadComment = v.object({ authorLogin: v.string(), body: v.string(), createdAt: v.number(), id: v.string() });

const vThread = v.object({
    canResolve: v.boolean(),
    canUnresolve: v.boolean(),
    comments: v.array(vThreadComment),
    id: v.string(),
    isOutdated: v.boolean(),
    isResolved: v.boolean(),
    line: v.union(v.number(), v.null()),
    path: v.string(),
    side: vDiffSide,
    startLine: v.union(v.number(), v.null()),
});

const vViewedFile = v.object({
    path: v.string(),
    state: v.union(v.literal("changed"), v.literal("unviewed"), v.literal("viewed")),
});

const vOk = v.object({ status: v.literal("ok") });

const vRef = {
    number: v.number(),
    repository: v.string().max(MAX_LENGTH.short),
};

const requireText = (text: string): void => {
    if (text.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "A reply needs some text");
    }
};

/** The review conversation: threads of line comments with their replies, a page at a time. */
export const getReviewThreads = authAction
    .use(rateLimit("sourceControl/read"))
    .input({ ...vRef, after: v.optional(v.string().max(MAX_LENGTH.cursor)) })
    .output(v.union(v.object({ endCursor: v.union(v.string(), v.null()), hasMore: v.boolean(), status: v.literal("ok"), threads: v.array(vThread) }), vFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            const page = await DEVELOP_DRIVER.listThreads(request, args, args.after ?? null);

            return { endCursor: page.endCursor, hasMore: page.hasMore, threads: page.items };
        });

        ctx.log.event("source_control.get_threads", { status: outcome.status });

        return outcome;
    });

/** Which files the user has marked viewed on the host, a page at a time. */
export const getViewedFiles = authAction
    .use(rateLimit("sourceControl/read"))
    .input({ ...vRef, after: v.optional(v.string().max(MAX_LENGTH.cursor)) })
    .output(
        v.union(v.object({ endCursor: v.union(v.string(), v.null()), files: v.array(vViewedFile), hasMore: v.boolean(), status: v.literal("ok") }), vFailed),
    )
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await readFromHost(DEVELOP_DRIVER, token, async (request) => {
            const page = await DEVELOP_DRIVER.listViewed(request, args, args.after ?? null);

            return { endCursor: page.endCursor, files: page.items, hasMore: page.hasMore };
        });

        ctx.log.event("source_control.get_viewed", { status: outcome.status });

        return outcome;
    });

/** Marks a file viewed (or not) on the host, so it follows the user to the host's own page. */
export const setFileViewed = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, path: v.string().max(MAX_LENGTH.key), viewed: v.boolean() })
    .output(v.union(vOk, vWriteFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            await DEVELOP_DRIVER.setViewed(request, args, args.path, args.viewed);

            return {};
        });

        ctx.log.event("source_control.set_viewed", { status: outcome.status, viewed: args.viewed });

        return outcome;
    });

/** Replies to a review thread. Posted at once: the host's review call has no place for a reply. */
export const replyToReviewThread = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ ...vRef, body: v.string().max(MAX_LENGTH.long), commentId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.object({ commentId: v.string(), status: v.literal("ok") }), vWriteFailed))
    .action(async ({ args, ctx }) => {
        requireText(args.body);

        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            const reply = await DEVELOP_DRIVER.replyToThread(request, args, args.commentId, args.body);

            return { commentId: reply.id };
        });

        ctx.log.event("source_control.reply", { status: outcome.status });

        return outcome;
    });

export const setReviewThreadResolved = authAction
    .use(rateLimit("sourceControl/write"))
    .input({ resolved: v.boolean(), threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(vOk, vWriteFailed))
    .action(async ({ args, ctx }) => {
        const token = await resolveGithubToken(ctx, ctx.user.userId);
        const outcome = await writeToHost(DEVELOP_DRIVER, token, async (request) => {
            await DEVELOP_DRIVER.setThreadResolved(request, args.threadId, args.resolved);

            return {};
        });

        ctx.log.event("source_control.resolve_thread", { resolved: args.resolved, status: outcome.status });

        return outcome;
    });

/**
 * Posts the draft as ONE review. The draft is claimed first (so a second device cannot post
 * it twice) and cleared only once the host confirmed the review: a refusal, a host that
 * cannot be reached and an answer that never came all keep it.
 */
export const submitReview = authAction
    .use(rateLimit("sourceControl/write"))
    .input(vRef)
    .output(
        v.union(
            v.object({ reviewUrl: v.union(v.string(), v.null()), status: v.literal("ok") }),
            v.object({ status: v.union(v.literal("in_progress"), v.literal("needs_text"), v.literal("needs_verdict"), v.literal("no_draft")) }),
            vWriteFailed,
        ),
    )
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const address = { number: args.number, repository: args.repository, userId };
        const token = await resolveGithubToken(ctx, userId);
        const outcome = await submitDraft({
            claim: async () => await ctx.runMutation(internal.source_control.review_internal.claimDraftForSubmit, address),
            finish: async (revision, sentIds, lease) => {
                // The host has the review; a draft left behind is for the lease to hold, but ops should see it.
                await ctx.runMutation(internal.source_control.review_internal.finishDraftSubmit, { ...address, lease, revision, sentIds }).catch((error: unknown) => {
                    ctx.log.event("source_control.submit_review_finish_failed", { message: error instanceof Error ? error.message : "unknown" });

                    throw error;
                });
            },
            post: async (submission) =>
                await writeToHost(DEVELOP_DRIVER, token, async (request) => {
                    return { review: await DEVELOP_DRIVER.submitReview(request, args, submission) };
                }),
            release: async (lease) => {
                await ctx.runMutation(internal.source_control.review_internal.releaseDraftSubmit, { ...address, lease });
            },
        });

        ctx.log.event("source_control.submit_review", { status: outcome.status });

        return outcome;
    });

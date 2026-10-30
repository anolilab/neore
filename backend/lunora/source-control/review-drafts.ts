/**
 * Develop mode: the review a user is writing, kept on the server (`reviewDrafts`) so
 * it survives a reload and follows them to another device. Nothing here calls the
 * host: a draft is only ours until the user submits it (`review-functions.ts`).
 *
 * Every row is the caller's own, stamped from `ctx.user`. The host the draft is for
 * comes from the driver, never from the client, so a draft cannot be filed under an
 * origin the user was not reviewing on.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import type { DraftComment } from "./draft-logic";
import { commitFor, draftBytes, isSubmitting, MAX_DRAFT_BYTES, MAX_DRAFT_COMMENTS } from "./draft-logic";
import { vDraftComment, vReviewVerdict } from "./validators";

const COMMIT_ID = /^[0-9a-f]{40,64}$/u;

const vDraft = v.object({
    body: v.string(),
    comments: v.array(vDraftComment),
    commitId: v.string(),
    revision: v.number(),
    submitting: v.boolean(),
    updatedAt: v.number(),
    verdict: v.union(vReviewVerdict, v.null()),
});

const vEdit = v.union(
    v.object({ commentId: v.union(v.string(), v.null()), revision: v.number(), status: v.literal("ok") }),
    v.object({ status: v.union(v.literal("head_moved"), v.literal("not_found"), v.literal("submitting"), v.literal("too_many")) }),
);

export const draftFor = async (ctx: QueryCtx | MutationCtx, userId: string, repo: string, number: number): Promise<Doc<"reviewDrafts"> | null> =>
    await ctx.db
        .query("reviewDrafts")
        .withIndex("by_user_and_pull", (q) => q.eq("userId", userId).eq("hostOrigin", DEVELOP_DRIVER.webOrigin).eq("repository", repo).eq("number", number))
        .first();

const requireAddress = (number: number): void => {
    if (!Number.isSafeInteger(number) || number < 1) {
        throw new LunoraError("BAD_REQUEST", "Not a pull request number");
    }
};

const requireCommit = (commitId: string): void => {
    if (!COMMIT_ID.test(commitId)) {
        throw new LunoraError("BAD_REQUEST", "Not a commit id");
    }
};

/** A comment's lines: whole, positive, and a range that ends on its last line. */
const requireLines = (line: number, startLine: number | null): void => {
    if (!Number.isSafeInteger(line) || line < 1 || (startLine !== null && (!Number.isSafeInteger(startLine) || startLine < 1 || startLine >= line))) {
        throw new LunoraError("BAD_REQUEST", "Not a line of the diff");
    }
};

/** A draft with nothing in it is not kept. */
const isEmpty = (draft: Pick<Doc<"reviewDrafts">, "body" | "comments" | "verdict">): boolean =>
    draft.comments.length === 0 && draft.body.trim() === "" && draft.verdict === null;

const toDraft = (draft: Doc<"reviewDrafts">, now: number) => {
    return {
        body: draft.body,
        comments: draft.comments,
        commitId: draft.commitId,
        revision: draft.revision,
        submitting: isSubmitting(draft, now),
        updatedAt: draft.updatedAt,
        verdict: draft.verdict,
    };
};

/** The draft for one pull request, live: a second device sees it as it is edited. */
export const getReviewDraft = authQuery
    .input({ number: v.number(), repository: v.string().max(MAX_LENGTH.short) })
    .output(v.union(v.from(vDraft), v.null()))
    .query(async ({ args, ctx }) => {
        const draft = await draftFor(ctx, ctx.user.userId, args.repository, args.number);

        // `submitting` is a snapshot at this run's start; every edit checks the lease again.
        return draft === null ? null : toDraft(draft, ctx.now);
    });

/** Adds a line comment, or replaces one when `commentId` names it. */
export const saveDraftComment = authMutation
    .use(rateLimit("sourceControl/draft"))
    .input({
        body: v.string().max(MAX_LENGTH.long),
        commentId: v.optional(v.string().max(MAX_LENGTH.id)),
        commitId: v.string().max(MAX_LENGTH.short),
        line: v.number(),
        number: v.number(),
        path: v.string().max(MAX_LENGTH.key),
        repository: v.string().max(MAX_LENGTH.short),
        side: v.union(v.literal("new"), v.literal("old")),
        startLine: v.union(v.number(), v.null()),
    })
    .output(v.from(vEdit))
    .mutation(async ({ args, ctx }) => {
        requireAddress(args.number);
        requireCommit(args.commitId);
        requireLines(args.line, args.startLine);

        if (args.body.trim() === "" || args.path === "") {
            throw new LunoraError("BAD_REQUEST", "A comment needs a file and some text");
        }

        const { now } = ctx;
        const draft = await draftFor(ctx, ctx.user.userId, args.repository, args.number);

        if (draft !== null && isSubmitting(draft, now)) {
            return { status: "submitting" as const };
        }

        const commitId = commitFor(draft, args.commitId);

        if (commitId === "head_moved") {
            return { status: "head_moved" as const };
        }

        const existing = args.commentId === undefined ? undefined : draft?.comments.find((comment) => comment.id === args.commentId);

        if (args.commentId !== undefined && existing === undefined) {
            return { status: "not_found" as const };
        }

        if (existing === undefined && (draft?.comments.length ?? 0) >= MAX_DRAFT_COMMENTS) {
            return { status: "too_many" as const };
        }

        const comment: DraftComment = {
            body: args.body,
            createdAt: existing?.createdAt ?? now,
            id: existing?.id ?? crypto.randomUUID(),
            line: args.line,
            path: args.path,
            side: args.side,
            startLine: args.startLine,
        };
        const comments =
            existing === undefined
                ? [...(draft?.comments ?? []), comment]
                : (draft?.comments ?? []).map((candidate) => (candidate.id === comment.id ? comment : candidate));

        if (draftBytes({ body: draft?.body ?? "", comments }) > MAX_DRAFT_BYTES) {
            return { status: "too_many" as const };
        }

        if (draft === null) {
            await ctx.db.insert("reviewDrafts", {
                body: "",
                comments,
                commitId,
                createdAt: now,
                hostOrigin: DEVELOP_DRIVER.webOrigin,
                number: args.number,
                repository: args.repository,
                revision: 1,
                submittingAt: 0,
                updatedAt: now,
                userId: ctx.user.userId,
                verdict: null,
            });

            return { commentId: comment.id, revision: 1, status: "ok" as const };
        }

        const revision = draft.revision + 1;

        await ctx.db.patch(draft._id, {
            comments,
            commitId,
            revision,
            updatedAt: now,
        });

        return { commentId: comment.id, revision, status: "ok" as const };
    });

export const deleteDraftComment = authMutation
    .use(rateLimit("sourceControl/draft"))
    .input({ commentId: v.string().max(MAX_LENGTH.id), number: v.number(), repository: v.string().max(MAX_LENGTH.short) })
    .output(v.from(vEdit))
    .mutation(async ({ args, ctx }) => {
        requireAddress(args.number);

        const { now } = ctx;
        const draft = await draftFor(ctx, ctx.user.userId, args.repository, args.number);

        if (draft === null || draft.comments.every((comment) => comment.id !== args.commentId)) {
            return { status: "not_found" as const };
        }

        if (isSubmitting(draft, now)) {
            return { status: "submitting" as const };
        }

        const comments = draft.comments.filter((comment) => comment.id !== args.commentId);

        if (isEmpty({ ...draft, comments })) {
            await ctx.db.delete(draft._id);

            return { commentId: null, revision: draft.revision + 1, status: "ok" as const };
        }

        await ctx.db.patch(draft._id, { comments, revision: draft.revision + 1, updatedAt: now });

        return { commentId: null, revision: draft.revision + 1, status: "ok" as const };
    });

/**
 * The review's summary and verdict. `verdict: null` takes the verdict back. Neither points at a line, so a new
 * head never refuses them: the draft keeps the commit its comments were written against.
 */
export const setDraftReview = authMutation
    .use(rateLimit("sourceControl/draft"))
    .input({
        body: v.string().max(MAX_LENGTH.long),
        commitId: v.string().max(MAX_LENGTH.short),
        number: v.number(),
        repository: v.string().max(MAX_LENGTH.short),
        verdict: v.union(vReviewVerdict, v.null()),
    })
    .output(v.from(vEdit))
    .mutation(async ({ args, ctx }) => {
        requireAddress(args.number);
        requireCommit(args.commitId);

        const { now } = ctx;
        const draft = await draftFor(ctx, ctx.user.userId, args.repository, args.number);

        if (draft !== null && isSubmitting(draft, now)) {
            return { status: "submitting" as const };
        }

        if (draftBytes({ body: args.body, comments: draft?.comments ?? [] }) > MAX_DRAFT_BYTES) {
            return { status: "too_many" as const };
        }

        if (draft === null) {
            if (isEmpty({ body: args.body, comments: [], verdict: args.verdict })) {
                return { commentId: null, revision: 0, status: "ok" as const };
            }

            await ctx.db.insert("reviewDrafts", {
                body: args.body,
                comments: [],
                commitId: args.commitId,
                createdAt: now,
                hostOrigin: DEVELOP_DRIVER.webOrigin,
                number: args.number,
                repository: args.repository,
                revision: 1,
                submittingAt: 0,
                updatedAt: now,
                userId: ctx.user.userId,
                verdict: args.verdict,
            });

            return { commentId: null, revision: 1, status: "ok" as const };
        }

        if (isEmpty({ body: args.body, comments: draft.comments, verdict: args.verdict })) {
            await ctx.db.delete(draft._id);

            return { commentId: null, revision: draft.revision + 1, status: "ok" as const };
        }

        await ctx.db.patch(draft._id, { body: args.body, revision: draft.revision + 1, updatedAt: now, verdict: args.verdict });

        return { commentId: null, revision: draft.revision + 1, status: "ok" as const };
    });

/** Throws the whole draft away. Refused while a submit holds it. */
export const discardReviewDraft = authMutation
    .use(rateLimit("sourceControl/draft"))
    .input({ number: v.number(), repository: v.string().max(MAX_LENGTH.short) })
    .output(v.union(v.object({ status: v.literal("ok") }), v.object({ status: v.literal("submitting") })))
    .mutation(async ({ args, ctx }) => {
        requireAddress(args.number);

        const draft = await draftFor(ctx, ctx.user.userId, args.repository, args.number);

        if (draft !== null && isSubmitting(draft, ctx.now)) {
            return { status: "submitting" as const };
        }

        if (draft !== null) {
            await ctx.db.delete(draft._id);
        }

        return { status: "ok" as const };
    });

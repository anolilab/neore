/**
 * The column validators of Develop's tables, declared once: `schema.ts` builds the
 * `reviewDrafts` and `watchedRepositories` tables from them and the procedures reuse them for outputs.
 *
 * Inline `v.union(...)` / `v.object({...})` literals only: codegen resolves an
 * inline validator expression, not one built by a call or a spread const.
 */
import { v } from "lunorash/server";

export const vReviewVerdict = v.union(v.literal("approve"), v.literal("comment"), v.literal("request_changes"));

export const vDiffSide = v.union(v.literal("new"), v.literal("old"));

/** One line comment waiting for the review to be submitted. `startLine` is `null` for a single line. */
export const vDraftComment = v.object({
    body: v.string(),
    createdAt: v.number(),
    id: v.string(),
    line: v.number(),
    path: v.string(),
    side: v.union(v.literal("new"), v.literal("old")),
    startLine: v.union(v.number(), v.null()),
});

/** A pull request that asks the user for a review, as a watched repository's cached list keeps it. */
export const vCachedRequest = v.object({
    authorLogin: v.string(),
    number: v.number(),
    title: v.string(),
    updatedAt: v.number(),
    url: v.string(),
});

/** How the last poll of a watched repository ended: `ok` (including a 304), or what a person can act on. */
export const vPollStatus = v.union(
    v.literal("ok"),
    v.literal("forbidden"),
    v.literal("host_error"),
    v.literal("needs_reconnect"),
    v.literal("not_connected"),
    v.literal("not_found"),
    v.literal("rate_limited"),
);

/** What a person can act on when a host call does not succeed. */
export const vFailed = v.object({
    status: v.union(
        v.literal("forbidden"),
        v.literal("host_error"),
        v.literal("needs_reconnect"),
        v.literal("not_connected"),
        v.literal("not_found"),
        v.literal("rate_limited"),
    ),
});

/** A write failed in a way a read cannot: the host refused it, or may have taken it without telling us. */
export const vWriteFailed = v.union(
    vFailed,
    v.object({ reason: v.union(v.string(), v.null()), status: v.literal("rejected") }),
    v.object({ status: v.literal("unconfirmed") }),
);

export const vMergeMethod = v.union(v.literal("merge"), v.literal("rebase"), v.literal("squash"));

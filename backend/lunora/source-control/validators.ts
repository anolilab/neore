/**
 * The review draft's column validators, declared once: `schema.ts` builds the
 * `reviewDrafts` table from them and the procedures reuse them for outputs.
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

// ─── Guides ─────────────────────────────────────────────────────────────────

export const vGuideStatus = v.union(v.literal("failed"), v.literal("generating"), v.literal("ready"));

export const vGuideSource = v.union(v.literal("cloud"), v.literal("host"));

/** Why a guide did not finish; a code the page words, never the model's or the host's own text. */
export const vGuideFailure = v.union(
    v.literal("abandoned"),
    v.literal("head_moved"),
    v.literal("host_error"),
    v.literal("model_error"),
    v.literal("no_answer"),
    v.literal("not_connected"),
    v.literal("quota"),
    v.literal("too_large"),
);

/** A place to read: lines of a file, on one side of the diff. */
export const vGuideRange = v.object({ end: v.number(), side: v.union(v.literal("new"), v.literal("old")), start: v.number() });

export const vGuideStop = v.object({
    explanation: v.string(),
    files: v.array(v.object({ path: v.string(), ranges: v.array(vGuideRange) })),
    id: v.string(),
    kind: v.union(v.literal("core"), v.literal("dependent"), v.literal("mechanical"), v.literal("uncovered")),
    title: v.string(),
});

/** What the guide suggests doing. Only `comment` can be applied, and applying it writes the review DRAFT, not the host. */
export const vGuideProposal = v.union(
    v.object({
        body: v.string(),
        id: v.string(),
        kind: v.literal("comment"),
        line: v.number(),
        path: v.string(),
        side: v.union(v.literal("new"), v.literal("old")),
        startLine: v.union(v.number(), v.null()),
        status: v.union(v.literal("applied"), v.literal("dismissed"), v.literal("proposed")),
    }),
    v.object({
        id: v.string(),
        kind: v.literal("label"),
        name: v.string(),
        reason: v.string(),
        status: v.union(v.literal("applied"), v.literal("dismissed"), v.literal("proposed")),
    }),
);

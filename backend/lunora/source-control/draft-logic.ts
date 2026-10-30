/**
 * The rules of a review draft, pure: how a draft ties to the commit it was written
 * against, when it may be submitted, and what a finished submit takes off it.
 * The procedures (`review-drafts.ts`, `review-internal.ts`) apply them to the row.
 */
import type { DiffSide, ReviewVerdict } from "./types";

/** Comments one draft holds. The length caps count characters, so `MAX_DRAFT_BYTES` is what keeps the row small. */
export const MAX_DRAFT_COMMENTS = 100;

/** UTF-8 bytes of a draft's text and comments, half a Durable Object's 2 MB row: CJK text is 3 bytes a character. */
export const MAX_DRAFT_BYTES = 1_000_000;

/** How long a submit holds its draft. A host call has a 15 s deadline, so a lease this long means the submitter died. */
export const SUBMIT_LEASE_MS = 60_000;

export interface DraftComment {
    body: string;
    createdAt: number;
    id: string;
    line: number;
    path: string;
    side: DiffSide;
    startLine: number | null;
}

export interface DraftState {
    body: string;
    comments: DraftComment[];
    commitId: string;
    submittingAt: number;
    verdict: ReviewVerdict | null;
}

/** A submit is in flight when it claimed the draft and its lease has not run out. */
export const isSubmitting = (draft: Pick<DraftState, "submittingAt">, now: number): boolean =>
    draft.submittingAt > 0 && now - draft.submittingAt < SUBMIT_LEASE_MS;

/**
 * The commit an edit is written against. Comment lines mean something only on the
 * commit the reviewer saw, so a draft that already holds comments keeps its commit:
 * an edit made on a newer head is refused (`"head_moved"`) rather than mixed in.
 * A draft with no comments just follows the head.
 */
export const commitFor = (draft: Pick<DraftState, "comments" | "commitId"> | null, headSha: string): "head_moved" | string => {
    if (draft === null || draft.comments.length === 0 || draft.commitId === headSha) {
        return headSha;
    }

    return "head_moved";
};

/** The bytes a draft's body and comments take in the row. */
export const draftBytes = (draft: Pick<DraftState, "body" | "comments">): number =>
    new TextEncoder().encode(JSON.stringify({ body: draft.body, comments: draft.comments })).byteLength;

export type SubmitBlocker = "needs_text" | "needs_verdict";

/** Why a draft cannot go to the host yet, answered before any host call. */
export const submitBlocker = (draft: Pick<DraftState, "body" | "comments" | "verdict">): SubmitBlocker | null => {
    if (draft.verdict === null) {
        return "needs_verdict";
    }

    const hasText = draft.body.trim() !== "";

    if (draft.verdict === "request_changes" && !hasText) {
        return "needs_text";
    }

    return draft.verdict === "comment" && !hasText && draft.comments.length === 0 ? "needs_text" : null;
};

/** The comments left on a draft that was edited while its submit ran: only those the host did not receive. */
export const withoutSent = (comments: DraftComment[], sentIds: ReadonlyArray<string>): DraftComment[] => {
    const sent = new Set(sentIds);

    return comments.filter((comment) => !sent.has(comment.id));
};

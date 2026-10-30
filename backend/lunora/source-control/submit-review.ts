/**
 * Submitting a review as one unit, with every effect injected so a test needs no
 * database, token or host. The order is the invariant:
 *
 * 1. CLAIM the draft, so a second device or tab cannot post the same review.
 * 2. Post it with ONE host call.
 * 3. Only when the host confirmed the review, CLEAR the draft (`finish`).
 *
 * Whatever else happens the draft stays and the claim is released, so a refusal
 * (`rejected`), a host that cannot be reached, or an answer that never came
 * (`unconfirmed`, the host may already have the review) all leave the reviewer
 * with their words.
 */
import type { DraftComment, SubmitBlocker } from "./draft-logic";
import { submitBlocker } from "./draft-logic";
import type { ReviewSubmission, SubmittedReview } from "./types";
import type { WriteOutcome } from "./write-host";

export interface ClaimedDraft {
    body: string;
    comments: DraftComment[];
    commitId: string;
    revision: number;
    verdict: ReviewSubmission["verdict"] | null;
}

export type Claim = { draft: ClaimedDraft; status: "claimed" } | { status: "in_progress" } | { status: "no_draft" };

export interface SubmitPorts {
    claim: () => Promise<Claim>;
    /** The draft was posted: take off it what the host received. */
    finish: (revision: number, sentIds: string[]) => Promise<void>;
    post: (submission: ReviewSubmission) => Promise<WriteOutcome<{ review: SubmittedReview }>>;
    /** Gives the claim back and keeps the draft. */
    release: () => Promise<void>;
}

export type SubmitOutcome =
    | Exclude<WriteOutcome<{ review: SubmittedReview }>, { status: "ok" }>
    | { reviewUrl: string | null; status: "ok" }
    | { status: "in_progress" | "no_draft" | SubmitBlocker };

export const submitDraft = async (ports: SubmitPorts): Promise<SubmitOutcome> => {
    const claim = await ports.claim();

    if (claim.status !== "claimed") {
        return { status: claim.status };
    }

    const { draft } = claim;
    const blocker = submitBlocker(draft);

    if (blocker !== null || draft.verdict === null) {
        await ports.release();

        return { status: blocker ?? "needs_verdict" };
    }

    let outcome: WriteOutcome<{ review: SubmittedReview }>;

    try {
        outcome = await ports.post({ body: draft.body, comments: draft.comments, commitId: draft.commitId, verdict: draft.verdict });
    } catch (error) {
        await ports.release();

        throw error;
    }

    if (outcome.status !== "ok") {
        await ports.release();

        return outcome;
    }

    await ports.finish(
        draft.revision,
        draft.comments.map((comment) => comment.id),
    );

    return { reviewUrl: outcome.review.url, status: "ok" };
};

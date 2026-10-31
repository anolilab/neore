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

/** How often clearing a posted draft is tried before it is left to the lease. */
const FINISH_ATTEMPTS = 3;

export interface ClaimedDraft {
    body: string;
    comments: DraftComment[];
    commitId: string;
    revision: number;
    verdict: ReviewSubmission["verdict"] | null;
}

/** What one submit posted: finishing clears from the draft only what still matches it. */
export interface SentReview {
    body: string;
    comments: { body: string; id: string }[];
    verdict: ReviewSubmission["verdict"];
}

/** `lease` is what the claim wrote to the row: finish and release act only while the row still holds it. */
export type Claim = { draft: ClaimedDraft; lease: number; status: "claimed" } | { status: "in_progress" } | { status: "no_draft" };

export interface SubmitPorts {
    claim: () => Promise<Claim>;
    /** The draft was posted: take off it what the host received. */
    finish: (revision: number, sent: SentReview, lease: number) => Promise<void>;
    post: (submission: ReviewSubmission) => Promise<WriteOutcome<{ review: SubmittedReview }>>;
    /** Gives the claim back and keeps the draft. */
    release: (lease: number) => Promise<void>;
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

    const { draft, lease } = claim;
    const blocker = submitBlocker(draft);

    if (blocker !== null || draft.verdict === null) {
        await ports.release(lease);

        return { status: blocker ?? "needs_verdict" };
    }

    let outcome: WriteOutcome<{ review: SubmittedReview }>;

    try {
        outcome = await ports.post({ body: draft.body, comments: draft.comments, commitId: draft.commitId, verdict: draft.verdict });
    } catch (error) {
        await ports.release(lease);

        throw error;
    }

    if (outcome.status !== "ok") {
        await ports.release(lease);

        return outcome;
    }

    // The host has the review. If clearing the draft fails, that is not a failed submit: telling the
    // person so would have them post the review a second time. Once the lease runs out another submit may
    // claim the draft and post it again, so clearing is retried before it is given up.
    const sent: SentReview = {
        body: draft.body,
        comments: draft.comments.map(({ body, id }) => {
            return { body, id };
        }),
        verdict: draft.verdict,
    };

    for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
        try {
            await ports.finish(draft.revision, sent, lease);

            break;
        } catch {
            // Tried again, then left to the lease.
        }
    }

    return { reviewUrl: outcome.review.url, status: "ok" };
};

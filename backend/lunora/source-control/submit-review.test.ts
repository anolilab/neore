import { describe, expect, it } from "vitest";

import type { DraftComment } from "./draft-logic";
import type { Claim, ClaimedDraft, SentReview, SubmitPorts } from "./submit-review";
import { submitDraft } from "./submit-review";
import type { ReviewSubmission, SubmittedReview } from "./types";
import type { WriteOutcome } from "./write-host";

const COMMIT = "a".repeat(40);

const comment = (id: string): DraftComment => {
    return { body: "nit", createdAt: 1, id, line: 4, path: "src/a.ts", side: "new", startLine: null };
};

const claimed = (overrides: Partial<ClaimedDraft> = {}): Claim => {
    return {
        draft: { body: "Looks fine", comments: [comment("c1"), comment("c2")], commitId: COMMIT, revision: 5, verdict: "approve", ...overrides },
        lease: 1234,
        status: "claimed",
    };
};

/** Ports that record the order of effects. */
const ports = (
    claim: Claim,
    post: (submission: ReviewSubmission) => Promise<WriteOutcome<{ review: SubmittedReview }>>,
    finish: () => Promise<void> = async () => {},
) => {
    const calls: string[] = [];
    const finished: { lease: number; revision: number; sent: SentReview }[] = [];
    const released: number[] = [];
    const posted: ReviewSubmission[] = [];
    const value: SubmitPorts = {
        claim: async () => {
            calls.push("claim");

            return claim;
        },
        finish: async (revision, sent, lease) => {
            calls.push("finish");
            finished.push({ lease, revision, sent });
            await finish();
        },
        post: async (submission) => {
            calls.push("post");
            posted.push(submission);

            return await post(submission);
        },
        release: async (lease) => {
            calls.push("release");
            released.push(lease);
        },
    };

    return { calls, finished, posted, released, value };
};

const accepted = async (): Promise<WriteOutcome<{ review: SubmittedReview }>> => {
    return { review: { id: "9", url: "https://github.com/o/r/pull/1#pullrequestreview-9" }, status: "ok" };
};

describe("submitDraft", () => {
    it("claims, posts the whole review once, and clears the draft only after the host confirmed it", async () => {
        const { calls, finished, posted, value } = ports(claimed(), accepted);

        expect(await submitDraft(value)).toEqual({ reviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-9", status: "ok" });
        expect(calls).toEqual(["claim", "post", "finish"]);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ body: "Looks fine", commitId: COMMIT, verdict: "approve" });
        expect(posted[0]?.comments).toHaveLength(2);
        expect(finished).toEqual([
            {
                lease: 1234,
                revision: 5,
                sent: {
                    body: "Looks fine",
                    comments: [
                        { body: "nit", id: "c1" },
                        { body: "nit", id: "c2" },
                    ],
                    verdict: "approve",
                },
            },
        ]);
    });

    it.each([
        ["refuses it", { reason: "Review Can not approve your own pull request", status: "rejected" }],
        ["cannot reach it", { status: "host_error" }],
        ["has lost the grant", { status: "needs_reconnect" }],
        ["is rate limited", { status: "rate_limited" }],
        ["may have taken it without answering", { status: "unconfirmed" }],
    ] as const)("keeps the draft and gives the claim back when the host %s", async (_name, failure) => {
        const { calls, finished, value } = ports(claimed(), async () => failure as WriteOutcome<{ review: SubmittedReview }>);

        expect(await submitDraft(value)).toEqual(failure);
        expect(calls).toEqual(["claim", "post", "release"]);
        expect(finished).toEqual([]);
    });

    it("hands the claim's lease back to release, so only that claim is given up", async () => {
        const { released, value } = ports(claimed(), async () => {
            return { status: "host_error" };
        });

        await submitDraft(value);
        expect(released).toEqual([1234]);
    });

    it("still reports the review as submitted when clearing the draft fails afterwards, so nobody posts it twice", async () => {
        const { calls, value } = ports(claimed(), accepted, async () => {
            throw new Error("database unavailable");
        });

        expect(await submitDraft(value)).toEqual({ reviewUrl: "https://github.com/o/r/pull/1#pullrequestreview-9", status: "ok" });
        // The claim is not released: the lease keeps the draft locked instead of inviting a resubmit at once.
        // Clearing is tried three times first, because once the lease runs out another submit could post it again.
        expect(calls).toEqual(["claim", "post", "finish", "finish", "finish"]);
    });

    it("stops clearing the draft at the first attempt that lands", async () => {
        let failures = 1;
        const { calls, value } = ports(claimed(), accepted, async () => {
            failures -= 1;

            if (failures >= 0) {
                throw new Error("database unavailable");
            }
        });

        expect(await submitDraft(value)).toMatchObject({ status: "ok" });
        expect(calls).toEqual(["claim", "post", "finish", "finish"]);
    });

    it("releases the claim and rethrows when the post fails unexpectedly", async () => {
        const { calls, finished, value } = ports(claimed(), async () => {
            throw new RangeError("bug");
        });

        await expect(submitDraft(value)).rejects.toBeInstanceOf(RangeError);
        expect(calls).toEqual(["claim", "post", "release"]);
        expect(finished).toEqual([]);
    });

    it("asks the host for nothing while another submit holds the draft, or there is none", async () => {
        for (const status of ["in_progress", "no_draft"] as const) {
            const { calls, value } = ports({ status }, accepted);

            expect(await submitDraft(value)).toEqual({ status });
            expect(calls).toEqual(["claim"]);
        }
    });

    it("gives the claim back without a host call when the draft cannot be submitted yet", async () => {
        const noVerdict = ports(claimed({ verdict: null }), accepted);

        expect(await submitDraft(noVerdict.value)).toEqual({ status: "needs_verdict" });
        expect(noVerdict.calls).toEqual(["claim", "release"]);

        const noWords = ports(claimed({ body: "", verdict: "request_changes" }), accepted);

        expect(await submitDraft(noWords.value)).toEqual({ status: "needs_text" });
        expect(noWords.calls).toEqual(["claim", "release"]);
    });
});

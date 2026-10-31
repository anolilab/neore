/**
 * Review drafts through the real procedures and tables: the draft is server-side (a second
 * device reads what the first wrote), a submit the host refuses keeps it, a confirmed one
 * clears it, and two submits at once post one review.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_DRAFT_COMMENTS, SUBMIT_LEASE_MS } from "./draft-logic";

import schema from "../schema";
import { claimDraftForSubmit, finishDraftSubmit, releaseDraftSubmit } from "./review-internal";
import { deleteDraftComment, discardReviewDraft, getReviewDraft, saveDraftComment, setDraftReview } from "./review-drafts";
import type { SubmitPorts } from "./submit-review";
import { submitDraft } from "./submit-review";
import type { ReviewSubmission, SubmittedReview } from "./types";
import type { WriteOutcome } from "./write-host";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const A = "user-a";
const B = "user-b";
const PULL = { number: 7, repository: "octo/hello" };
const HEAD = "a".repeat(40);
const NEWER = "b".repeat(40);

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const as = (userId: string) => harness.withIdentity({ userId });

const comment = (overrides: Record<string, unknown> = {}) => {
    return { body: "rename this", commitId: HEAD, line: 12, path: "src/a.ts", side: "new", startLine: null, ...PULL, ...overrides };
};

const save = async (userId: string, overrides: Record<string, unknown> = {}): Promise<any> =>
    await as(userId).mutation(saveDraftComment as never, comment(overrides) as never);

const read = async (userId: string): Promise<any> => await as(userId).query(getReviewDraft as never, PULL as never);

/** The comments of a user's draft, `[]` when there is none. */
const commentsOf = async (userId: string): Promise<any[]> => {
    const draft = await read(userId);

    return draft === null ? [] : draft.comments;
};

const idsOf = async (userId: string): Promise<string[]> => {
    const comments = await commentsOf(userId);

    return comments.map((entry: any) => entry.id);
};

const rows = async (): Promise<any[]> => await harness.run(async (ctx: any) => await ctx.db.query("reviewDrafts").collect());

/** The submit action's ports, over the real internal mutations and a host that answers `host`. */
const portsFor = (userId: string, host: (submission: ReviewSubmission) => Promise<WriteOutcome<{ review: SubmittedReview }>>) => {
    const address = { ...PULL, userId };
    const posted: ReviewSubmission[] = [];
    const value: SubmitPorts = {
        claim: async () => (await harness.run(async (ctx: any) => await ctx.runMutation(claimDraftForSubmit, address))) as never,
        finish: async (revision, sent, lease) => {
            await harness.run(async (ctx: any) => await ctx.runMutation(finishDraftSubmit, { ...address, lease, revision, sent }));
        },
        post: async (submission) => {
            posted.push(submission);

            return await host(submission);
        },
        release: async (lease) => {
            await harness.run(async (ctx: any) => await ctx.runMutation(releaseDraftSubmit, { ...address, lease }));
        },
    };

    return { posted, value };
};

const confirmed = async (): Promise<WriteOutcome<{ review: SubmittedReview }>> => {
    return { review: { id: "9", url: "https://github.com/octo/hello/pull/7#pullrequestreview-9" }, status: "ok" };
};

describe("a draft lives on the server", () => {
    it("is there for a reload and for a second device, which sees the edits of the first", async () => {
        expect(await read(A)).toBeNull();

        const first = await save(A);

        expect(first).toMatchObject({ revision: 1, status: "ok" });
        await as(A).mutation(setDraftReview as never, { ...PULL, body: "Two nits", commitId: HEAD, verdict: "request_changes" } as never);

        // A "second device" is another request for the same user: the draft is in the table, not in any page.
        const seen = await read(A);

        expect(seen).toMatchObject({ body: "Two nits", commitId: HEAD, submitting: false, verdict: "request_changes" });
        expect(seen.comments).toEqual([expect.objectContaining({ body: "rename this", id: first.commentId, line: 12, path: "src/a.ts", side: "new" })]);
        expect(await rows()).toHaveLength(1);
    });

    it("keeps every user's draft to themselves", async () => {
        await save(A);

        expect(await read(B)).toBeNull();
        expect(await save(B, { body: "mine" })).toMatchObject({ status: "ok" });

        const [firstA] = await commentsOf(A);

        expect(firstA.body).toBe("rename this");
        const [firstB] = await commentsOf(B);

        expect(firstB.body).toBe("mine");
    });

    it("edits and removes a comment by id, and drops the row once nothing is left", async () => {
        const one = await save(A);
        const two = await save(A, { line: 20 });

        expect(await commentsOf(A)).toHaveLength(2);
        expect(await save(A, { body: "better name", commentId: one.commentId })).toMatchObject({ commentId: one.commentId, status: "ok" });
        const comments = await commentsOf(A);

        expect(comments.find((entry: any) => entry.id === one.commentId).body).toBe("better name");
        expect(await save(A, { commentId: "nope" })).toEqual({ status: "not_found" });

        await as(A).mutation(deleteDraftComment as never, { ...PULL, commentId: one.commentId } as never);
        expect(await idsOf(A)).toEqual([two.commentId]);
        await as(A).mutation(deleteDraftComment as never, { ...PULL, commentId: two.commentId } as never);
        expect(await read(A)).toBeNull();
        expect(await rows()).toEqual([]);
    });

    it("refuses a newer head once comments are written against the old one, and a draft past the cap", async () => {
        await save(A);

        expect(await save(A, { commitId: NEWER })).toEqual({ status: "head_moved" });

        // A verdict and a summary point at no line, so a new head never blocks them: the draft stays submittable.
        expect(await as(A).mutation(setDraftReview as never, { ...PULL, body: "x", commitId: NEWER, verdict: "comment" } as never)).toMatchObject({
            status: "ok",
        });
        expect(await read(A)).toMatchObject({ body: "x", commitId: HEAD, verdict: "comment" });

        for (let index = 1; index < MAX_DRAFT_COMMENTS; index += 1) {
            await save(A, { line: index + 1 });
        }

        expect(await save(A, { line: 500 })).toEqual({ status: "too_many" });
    });

    it("lets a draft with no comments follow the head, so a verdict is posted on the commit now shown", async () => {
        await as(A).mutation(setDraftReview as never, { ...PULL, body: "ok", commitId: HEAD, verdict: "approve" } as never);
        await as(A).mutation(setDraftReview as never, { ...PULL, body: "ok", commitId: NEWER, verdict: "approve" } as never);

        expect(await read(A)).toMatchObject({ commitId: NEWER });
    });

    it("counts bytes, not characters: CJK text past the row budget is refused as too long", async () => {
        // 10,000 characters (the cap on one comment) is 30,000 bytes in UTF-8: 100 of them would be 3 MB.
        const wide = "字".repeat(10_000);
        let saved = 0;

        for (; saved < MAX_DRAFT_COMMENTS; saved += 1) {
            const outcome = await save(A, { body: wide, line: saved + 1 });

            if (outcome.status !== "ok") {
                expect(outcome).toEqual({ status: "too_many" });

                break;
            }
        }

        expect(saved).toBeGreaterThan(0);
        expect(saved).toBeLessThan(MAX_DRAFT_COMMENTS);
        expect(await as(A).mutation(setDraftReview as never, { ...PULL, body: wide, commitId: HEAD, verdict: "comment" } as never)).toEqual({
            status: "too_many",
        });
        expect(await commentsOf(A)).toHaveLength(saved);
    });

    it("refuses lines, commits and text that are not any", async () => {
        for (const bad of [{ line: 0 }, { line: 1.5 }, { line: 5, startLine: 5 }, { commitId: "main" }, { body: "  " }]) {
            await expect(save(A, bad)).rejects.toThrow();
        }

        expect(await rows()).toEqual([]);
    });

    it("discards a draft", async () => {
        await save(A);
        await as(A).mutation(discardReviewDraft as never, PULL as never);

        expect(await read(A)).toBeNull();
    });
});

describe("submitting", () => {
    const seedReady = async () => {
        await save(A);
        await save(A, { line: 30, side: "old", startLine: 28 });
        await as(A).mutation(setDraftReview as never, { ...PULL, body: "Two nits", commitId: HEAD, verdict: "request_changes" } as never);
    };

    it("clears the draft only after the host confirmed the review, with every comment in one post", async () => {
        await seedReady();

        const { posted, value } = portsFor(A, confirmed);

        expect(await submitDraft(value)).toEqual({ reviewUrl: "https://github.com/octo/hello/pull/7#pullrequestreview-9", status: "ok" });
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ body: "Two nits", commitId: HEAD, verdict: "request_changes" });
        expect(posted[0]?.comments.map((entry) => [entry.path, entry.line, entry.side, entry.startLine])).toEqual([
            ["src/a.ts", 12, "new", null],
            ["src/a.ts", 30, "old", 28],
        ]);
        expect(await read(A)).toBeNull();
    });

    it.each([
        ["refuses it", { reason: "Can not approve your own pull request", status: "rejected" }],
        ["fails", { status: "host_error" }],
        ["may have taken it", { status: "unconfirmed" }],
    ] as const)("keeps the draft intact, and submittable again, when the host %s", async (_name, failure) => {
        await seedReady();

        const before = await read(A);
        const { value } = portsFor(A, async () => failure as WriteOutcome<{ review: SubmittedReview }>);

        expect(await submitDraft(value)).toEqual(failure);

        const after = await read(A);

        expect(after).toEqual({ ...before, submitting: false });
        expect(await submitDraft(portsFor(A, confirmed).value)).toMatchObject({ status: "ok" });
        expect(await read(A)).toBeNull();
    });

    it("posts ONE review when two devices submit at once", async () => {
        await seedReady();

        let answered = false;
        const slow = portsFor(A, async () => {
            await vi.waitFor(() => expect(answered).toBe(true));

            return await confirmed();
        });
        const second = portsFor(A, confirmed);
        const firstSubmit = submitDraft(slow.value);

        // The first has claimed the draft and is waiting on the host.
        await vi.waitFor(async () => expect(await read(A)).toMatchObject({ submitting: true }));

        expect(await submitDraft(second.value)).toEqual({ status: "in_progress" });
        expect(second.posted).toEqual([]);
        // Edits wait too: the draft being posted must not change under it.
        expect(await save(A, { line: 99 })).toEqual({ status: "submitting" });
        expect(await as(A).mutation(discardReviewDraft as never, PULL as never)).toEqual({ status: "submitting" });

        answered = true;

        expect(await firstSubmit).toMatchObject({ status: "ok" });
        expect(slow.posted).toHaveLength(1);
        expect(await read(A)).toBeNull();
    });

    it("takes over a claim whose lease ran out, because its submitter died", async () => {
        await seedReady();
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("reviewDrafts").collect();

            await ctx.db.patch(row._id, { submittingAt: Date.now() - SUBMIT_LEASE_MS - 1000 });
        });

        expect(await submitDraft(portsFor(A, confirmed).value)).toMatchObject({ status: "ok" });
    });

    it("keeps what the host did not receive when the draft was edited under a late finish", async () => {
        await seedReady();

        const { value } = portsFor(A, confirmed);
        const claim = await value.claim();

        expect(claim.status).toBe("claimed");

        // The lease ran out while the host call was in flight, and the user added a comment.
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("reviewDrafts").collect();

            await ctx.db.patch(row._id, {
                comments: [...row.comments, { body: "late", createdAt: 1, id: "late", line: 3, path: "z.ts", side: "new", startLine: null }],
                revision: row.revision + 1,
            });
        });

        if (claim.status === "claimed") {
            await value.finish(
                claim.draft.revision,
                {
                    body: claim.draft.body,
                    comments: claim.draft.comments.map(({ body, id }) => {
                        return { body, id };
                    }),
                    verdict: claim.draft.verdict ?? "comment",
                },
                claim.lease,
            );
        }

        expect(await idsOf(A)).toEqual(["late"]);
        // What went out with the review (the summary and the verdict) is not left to go out a second time.
        expect(await read(A)).toMatchObject({ body: "", verdict: null });
    });

    it("keeps a summary and a comment edited under a late finish: they were not posted as they read now", async () => {
        await seedReady();

        const { value } = portsFor(A, confirmed);
        const claim = await value.claim();

        expect(claim.status).toBe("claimed");

        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("reviewDrafts").collect();

            await ctx.db.patch(row._id, {
                body: "rewritten summary",
                comments: row.comments.map((entry: { body: string }, index: number) => (index === 0 ? { ...entry, body: "rewritten" } : entry)),
                revision: row.revision + 1,
            });
        });

        if (claim.status === "claimed") {
            await value.finish(
                claim.draft.revision,
                {
                    body: claim.draft.body,
                    comments: claim.draft.comments.map(({ body, id }) => {
                        return { body, id };
                    }),
                    verdict: claim.draft.verdict ?? "comment",
                },
                claim.lease,
            );
        }

        const draft = await read(A);

        expect(draft).toMatchObject({ body: "rewritten summary" });
        expect(draft?.comments.map((entry: { body: string }) => entry.body)).toEqual(["rewritten"]);
    });

    it("leaves a draft another submit has claimed since alone when a late finish or release arrives", async () => {
        await seedReady();

        const { value } = portsFor(A, confirmed);
        const stale = await value.claim();

        expect(stale.status).toBe("claimed");

        // The first submitter's lease ran out and a second device took the draft over.
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("reviewDrafts").collect();

            await ctx.db.patch(row._id, { submittingAt: Date.now() - SUBMIT_LEASE_MS - 1000 });
        });

        const fresh = await value.claim();

        expect(fresh.status).toBe("claimed");

        if (stale.status === "claimed" && fresh.status === "claimed") {
            expect(fresh.lease).not.toBe(stale.lease);

            await value.release(stale.lease);
            expect(await read(A)).toMatchObject({ submitting: true });

            await value.finish(stale.draft.revision, { body: "", comments: [], verdict: "comment" }, stale.lease);
            expect(await read(A)).toMatchObject({ body: "Two nits", submitting: true });
            expect(await commentsOf(A)).toHaveLength(2);

            await value.finish(fresh.draft.revision, { body: "", comments: [], verdict: "comment" }, fresh.lease);
            expect(await read(A)).toBeNull();
        }
    });

    it("has nothing to submit without a draft", async () => {
        const { posted, value } = portsFor(A, confirmed);

        expect(await submitDraft(value)).toEqual({ status: "no_draft" });
        expect(posted).toEqual([]);
    });
});

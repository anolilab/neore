/**
 * Guides through the real procedures and tables: a new head commit marks the guide stale, a proposed comment
 * reaches the review DRAFT only when the user applies it (and the host not at all), and one user cannot touch
 * another's guide.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { applyGuideProposal, dismissGuideProposal, getGuide } from "./guide-functions";
import { beginGuide, failAbandonedGuide, failGuide, saveGuide } from "./guide-internal";
import { GUIDE_RUN_WINDOW_MS } from "./guide-logic";
import { getReviewDraft } from "./review-drafts";

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

const PROPOSALS = [
    {
        body: "Rename this",
        id: "proposal-1",
        kind: "comment" as const,
        line: 3,
        path: "src/a.ts",
        side: "new" as const,
        startLine: null,
        status: "proposed" as const,
    },
    { id: "proposal-2", kind: "label" as const, name: "needs-tests", reason: "No test", status: "proposed" as const },
];
const STOPS = [
    {
        explanation: "x",
        files: [{ path: "src/a.ts", ranges: [{ end: 4, side: "new" as const, start: 2 }] }],
        id: "stop-1",
        kind: "core" as const,
        title: "Core",
    },
];

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const as = (userId: string) => harness.withIdentity({ userId });

const run = async <T>(function_: (ctx: any) => Promise<T>): Promise<T> => await harness.run(function_);

const begin = async (userId: string, headSha = HEAD, jobId = "job-1"): Promise<any> =>
    await run(async (ctx) => await ctx.runMutation(beginGuide, { headSha, instructions: "Look at errors", jobId, source: "cloud", userId, ...PULL }));

const finish = async (userId: string, guideId: string, headSha = HEAD, proposals: unknown[] = PROPOSALS): Promise<boolean> =>
    await run(async (ctx) => await ctx.runMutation(saveGuide, { guideId, headSha, leftOut: 0, proposals, stops: STOPS, summary: "Adds a thing.", userId }));

const guideFor = async (userId: string, headSha: string): Promise<any> => await as(userId).query(getGuide as never, { ...PULL, headSha } as never);

const readyGuide = async (userId = A, headSha = HEAD): Promise<string> => {
    const started = await begin(userId, headSha);

    await finish(userId, started.guideId, headSha);

    return started.guideId;
};

describe("a guide and the head commit", () => {
    it("is current for the head it was written for and stale once the pull request has a new head", async () => {
        await readyGuide();

        expect(await guideFor(A, HEAD)).toMatchObject({ freshness: "current", guide: { headSha: HEAD, status: "ready" } });
        expect(await guideFor(A, NEWER)).toMatchObject({ freshness: "stale", guide: { headSha: HEAD, status: "ready" } });
    });

    it("keeps a guide per head: the new head's guide is current, and the older one is not shown over it", async () => {
        await readyGuide(A, HEAD);
        await readyGuide(A, NEWER);

        expect(await guideFor(A, NEWER)).toMatchObject({ freshness: "current", guide: { headSha: NEWER } });
    });

    it("saves the head the guide was actually written from", async () => {
        const started = await begin(A, HEAD);

        await finish(A, started.guideId, NEWER);

        expect(await guideFor(A, NEWER)).toMatchObject({ freshness: "current" });
    });

    it("is null when there is none, and another user's guide is not shown", async () => {
        expect(await guideFor(A, HEAD)).toBeNull();

        await readyGuide(B);

        expect(await guideFor(A, HEAD)).toBeNull();
    });

    it("runs one at a time per pull request, and reads a run that outlived its window as failed", async () => {
        const first = await begin(A);

        expect(await begin(A, HEAD, "job-2")).toMatchObject({ status: "running" });
        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { status: "generating" } });

        await run(async (ctx) => {
            await ctx.db.patch(first.guideId, { updatedAt: Date.now() - GUIDE_RUN_WINDOW_MS - 1000 });
        });

        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { failure: "abandoned", status: "failed" } });
        expect(await begin(A, HEAD, "job-3")).toMatchObject({ status: "started" });
    });

    it("keeps only the newest few guides of a pull request", async () => {
        for (let index = 0; index < 5; index += 1) {
            await readyGuide(A, String(index).repeat(40));
        }

        const rows = await run(async (ctx) => await ctx.db.query("pullRequestGuides").collect());

        expect(rows).toHaveLength(3);
    });

    it("takes a result once: a redelivered job, or one for a failed row, writes nothing", async () => {
        const started = await begin(A);

        expect(await finish(A, started.guideId)).toBe(true);
        expect(await finish(A, started.guideId, NEWER)).toBe(false);
        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { headSha: HEAD } });
    });

    it("does not take a result that arrives after the run's window: that run is already read as abandoned", async () => {
        const first = await begin(A);

        await run(async (ctx) => {
            await ctx.db.patch(first.guideId, { updatedAt: Date.now() - GUIDE_RUN_WINDOW_MS - 1000 });
        });

        expect(await finish(A, first.guideId)).toBe(false);
        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { failure: "abandoned", status: "failed" } });
    });

    it("fails an abandoned run only for the claim that owns it", async () => {
        const started = await begin(A, HEAD, "job-1");

        expect(await run(async (ctx) => await ctx.runMutation(failAbandonedGuide, { claimKey: "other", guideId: started.guideId, userId: A }))).toBe(false);
        expect(await run(async (ctx) => await ctx.runMutation(failAbandonedGuide, { claimKey: "job-1", guideId: started.guideId, userId: A }))).toBe(true);
        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { failure: "abandoned", status: "failed" } });
    });

    it("records why a run failed", async () => {
        const started = await begin(A);

        await run(async (ctx) => await ctx.runMutation(failGuide, { failure: "model_error", guideId: started.guideId, userId: A }));

        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { failure: "model_error", status: "failed" } });
    });
});

describe("applying a proposal", () => {
    const draft = async (userId: string): Promise<any> => await as(userId).query(getReviewDraft as never, PULL as never);

    it("proposes without writing anything: no draft exists until the user applies a comment", async () => {
        await readyGuide();

        expect(await draft(A)).toBeNull();
    });

    it("writes the comment into the review draft, once, and nowhere else", async () => {
        const guideId = await readyGuide();
        const applied = await as(A).mutation(applyGuideProposal as never, { guideId, headSha: HEAD, proposalId: "proposal-1" } as never);

        expect(applied).toMatchObject({ status: "applied" });
        expect(await draft(A)).toMatchObject({ comments: [{ body: "Rename this", line: 3, path: "src/a.ts", side: "new" }] });
        expect(await draft(A)).toMatchObject({ commitId: HEAD });
        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { proposals: [{ status: "applied" }, { status: "proposed" }] } });
        // A second apply does not double the comment.
        expect(await as(A).mutation(applyGuideProposal as never, { guideId, headSha: HEAD, proposalId: "proposal-1" } as never)).toEqual({ status: "not_ready" });
        expect(await draft(A)).toMatchObject({ comments: [expect.anything()] });
    });

    it("cannot apply a label: there is no write to apply it with", async () => {
        const guideId = await readyGuide();

        expect(await as(A).mutation(applyGuideProposal as never, { guideId, headSha: HEAD, proposalId: "proposal-2" } as never)).toEqual({ status: "not_found" });
        expect(await draft(A)).toBeNull();
    });

    it("is refused for a guide that is not finished", async () => {
        const started = await begin(A);

        expect(await as(A).mutation(applyGuideProposal as never, { guideId: started.guideId, headSha: HEAD, proposalId: "proposal-1" } as never)).toEqual({
            status: "not_found",
        });
    });

    it("is refused when the draft was started on another head", async () => {
        const guideId = await readyGuide(A, HEAD);
        const newer = await readyGuide(A, NEWER);

        await as(A).mutation(applyGuideProposal as never, { guideId: newer, headSha: NEWER, proposalId: "proposal-1" } as never);

        expect(await as(A).mutation(applyGuideProposal as never, { guideId, headSha: HEAD, proposalId: "proposal-1" } as never)).toEqual({ status: "head_moved" });
    });

    it("is refused when the page's head is no longer the guide's, even with no draft to compare against", async () => {
        const guideId = await readyGuide(A, HEAD);

        expect(await as(A).mutation(applyGuideProposal as never, { guideId, headSha: NEWER, proposalId: "proposal-1" } as never)).toEqual({
            status: "head_moved",
        });
        expect(await draft(A)).toBeNull();
        expect(await guideFor(A, HEAD)).toMatchObject({ guide: { proposals: [{ status: "proposed" }, { status: "proposed" }] } });
    });

    it("never touches another user's guide", async () => {
        const guideId = await readyGuide(A);

        expect(await as(B).mutation(applyGuideProposal as never, { guideId, headSha: HEAD, proposalId: "proposal-1" } as never)).toEqual({ status: "not_found" });
        expect(await as(B).mutation(dismissGuideProposal as never, { guideId, proposalId: "proposal-1" } as never)).toEqual({ status: "not_found" });
        expect(await draft(B)).toBeNull();
    });

    it("lets a proposal be dismissed, and then not applied", async () => {
        const guideId = await readyGuide();

        expect(await as(A).mutation(dismissGuideProposal as never, { guideId, proposalId: "proposal-1" } as never)).toEqual({ status: "dismissed" });
        expect(await as(A).mutation(applyGuideProposal as never, { guideId, headSha: HEAD, proposalId: "proposal-1" } as never)).toEqual({ status: "not_ready" });
        expect(await draft(A)).toBeNull();
    });
});

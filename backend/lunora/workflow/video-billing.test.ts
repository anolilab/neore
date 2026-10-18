import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import type { WorkflowNode } from "./core";
import { runBilledVideo, type VideoRunCosts, workflowVideoErrors } from "./video-billing";
import { executionContextOf } from "./test-execution-context";
import type { RunAccount } from "./run-setup";

/** Paid-plan and priced per 5 s block. */
const PAID = "fal-ai/luma-dream-machine/ray-2";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

const account = (overrides: Partial<RunAccount> = {}): RunAccount => {
    return { isAdmin: false, isAnonymous: false, orgId: "org-1", plan: null, ...overrides };
};

interface Answers {
    creditsLeft?: number | null;
    limitOk?: boolean;
}

/** A context whose queries answer from `answers`; mutations record what they were asked to do. */
const makeCtx = ({ creditsLeft = null, limitOk = true }: Answers = {}) => {
    const runQuery = vi.fn(async (reference: unknown) => {
        if (reference === internal.auth.billing.creditsLeftQuery) {
            return { creditsLeft };
        }

        throw new Error("unexpected query");
    });
    const runMutation = vi.fn(async (reference: unknown, _args?: unknown) => {
        if (reference === internal.chat.daily_charge.chargeDailyUnit) {
            return limitOk;
        }

        return undefined;
    });

    return { runMutation, runQuery };
};

const videoNode = node("gen", "video", { label: "Hero", mode: "text-to-video", model: PAID });
/** 5 s of Ray 2 at 540p: one 5 s block at 0.50. */
const CLIP = 500_000;
/** A 5 s frame extraction: 0.0002 a second. */
const FRAME = 1000;
const costs = (overrides: Partial<VideoRunCosts> = {}): VideoRunCosts => {
    return { clipMicrodollars: CLIP, extractionMicrodollars: undefined, ...overrides };
};

describe("workflowVideoErrors", () => {
    it("refuses a guest, before any node runs", () => {
        expect(workflowVideoErrors(account({ isAnonymous: true }), [videoNode])).toStrictEqual(["Create an account to generate video in a workflow"]);
    });

    it("refuses a paid-plan video model on a free plan, and allows it on a paid plan or for an admin", () => {
        expect(workflowVideoErrors(account({ plan: null }), [videoNode])).toHaveLength(1);
        expect(workflowVideoErrors(account({ plan: "premium" }), [videoNode])).toStrictEqual([]);
        expect(workflowVideoErrors(account({ isAdmin: true }), [videoNode])).toStrictEqual([]);
    });

    it("lets the untouched default text-to-video node run, since it needs no paid plan", () => {
        expect(workflowVideoErrors(account({ plan: null }), [node("d", "video", { mode: "text-to-video" })])).toStrictEqual([]);
    });

    it("reads nothing for a graph with no video node", () => {
        expect(workflowVideoErrors(account({ isAnonymous: true }), [node("t", "text", {})])).toStrictEqual([]);
    });
});

describe("runBilledVideo", () => {
    it("takes one unit of the daily video quota for the run's organization, then charges the finished clip once per run and node", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000 });
        const dispatch = vi.fn(async () => "clip");

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), dispatch)).resolves.toBe("clip");

        expect(ctx.runMutation).toHaveBeenCalledWith(internal.chat.daily_charge.chargeDailyUnit, {
            kind: "Video",
            organizationId: "org-1",
            requestId: 'workflow-video:["run","gen"]',
            userId: "u1",
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.auth.billing.deductCreditsFromGateway, {
            billingMode: "platform",
            costMicrodollars: CLIP,
            modelId: PAID,
            orgId: "org-1",
            requestId: 'workflow-video:["run","gen"]',
            userId: "u1",
        });
    });

    it("refuses a clip the account has no credits left for, before the quota or any paid call", async () => {
        // 500,000 microdollars is 500 credits (1 credit = 1,000 microdollars).
        const ctx = makeCtx({ creditsLeft: 100 });
        const dispatch = vi.fn(async () => "clip");

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), dispatch)).rejects.toThrow(
            'Not enough credits for the "Hero" video: it costs 500 and 100 are left',
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it("checks the clip and the frame extraction together, before the first paid call", async () => {
        // 501 credits for the clip and the frame: one short of 502 left, so refused. With 501 left it runs.
        const short = makeCtx({ creditsLeft: 500 });
        const dispatch = vi.fn(async () => "clip");

        await expect(
            runBilledVideo(short, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs({ extractionMicrodollars: FRAME }), dispatch),
        ).rejects.toThrow("it costs 501 and 500 are left");
        expect(dispatch).not.toHaveBeenCalled();

        const enough = makeCtx({ creditsLeft: 501 });

        await runBilledVideo(enough, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs({ extractionMicrodollars: FRAME }), async () => "clip");
        expect(enough.runMutation).toHaveBeenCalledWith(internal.chat.daily_charge.chargeDailyUnit, expect.anything());
    });

    it("refuses when the daily quota is spent, before any paid call", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000, limitOk: false });
        const dispatch = vi.fn(async () => "clip");

        await expect(runBilledVideo(ctx, executionContextOf(), videoNode, "u1", costs(), dispatch)).rejects.toThrow("daily video generation limit");
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("keys the daily unit on the node run, so a retry of the node takes no second unit and a new run takes its own", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000 });
        const quotaCall = (run: string) => {
            return { kind: "Video", organizationId: "org-1", requestId: `workflow-video:${JSON.stringify([run, "gen"])}`, userId: "u1" };
        };

        await runBilledVideo(ctx, executionContextOf({ orgId: "org-1", runId: "run-a" }), videoNode, "u1", costs(), async () => "clip");
        await runBilledVideo(ctx, executionContextOf({ orgId: "org-1", runId: "run-a" }), videoNode, "u1", costs(), async () => "clip");
        await runBilledVideo(ctx, executionContextOf({ orgId: "org-1", runId: "run-b" }), videoNode, "u1", costs(), async () => "clip");

        const quotaCalls = ctx.runMutation.mock.calls.filter(([reference]) => reference === internal.chat.daily_charge.chargeDailyUnit);

        expect(quotaCalls.map(([, args]) => args)).toStrictEqual([quotaCall("run-a"), quotaCall("run-a"), quotaCall("run-b")]);
    });

    it("retries a run the quota refused, and the retry is charged the unit again", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000, limitOk: false });
        const dispatch = vi.fn(async () => "clip");

        await expect(runBilledVideo(ctx, executionContextOf(), videoNode, "u1", costs(), dispatch)).rejects.toThrow("daily video generation limit");

        // The mutation released the refused request's claim, so the same request asks for its unit again.
        ctx.runMutation.mockImplementation(async () => true);

        await expect(runBilledVideo(ctx, executionContextOf(), videoNode, "u1", costs(), dispatch)).resolves.toBe("clip");
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it("charges nothing for a clip whose generation failed", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000 });

        await expect(
            runBilledVideo(ctx, executionContextOf(), videoNode, "u1", costs(), async () => {
                throw new Error("fal is down");
            }),
        ).rejects.toThrow("fal is down");
        expect(ctx.runMutation.mock.calls.some(([reference]) => reference === internal.auth.billing.deductCreditsFromGateway)).toBe(false);
    });

    it("does not refuse for a member with no credit record, and does not check credits for an unpriced model", async () => {
        const noRecord = makeCtx({ creditsLeft: null });

        await runBilledVideo(noRecord, executionContextOf(), videoNode, "u1", costs(), async () => "clip");
        expect(noRecord.runMutation).toHaveBeenCalledWith(internal.chat.daily_charge.chargeDailyUnit, expect.anything());

        const unpriced = makeCtx({ creditsLeft: 0 });

        await runBilledVideo(unpriced, executionContextOf(), videoNode, "u1", costs({ clipMicrodollars: undefined }), async () => "clip");
        expect(unpriced.runQuery).not.toHaveBeenCalled();
        expect(unpriced.runMutation.mock.calls.some(([reference]) => reference === internal.auth.billing.deductCreditsFromGateway)).toBe(false);
    });

    it("charges nothing without an organization, and keeps a finished clip when its charge cannot be recorded", async () => {
        const noOrg = makeCtx();

        await runBilledVideo(noOrg, executionContextOf({ orgId: undefined }), videoNode, "u1", costs(), async () => "clip");
        expect(noOrg.runMutation.mock.calls.some(([reference]) => reference === internal.auth.billing.deductCreditsFromGateway)).toBe(false);

        const failing = makeCtx();

        failing.runMutation.mockImplementation(async (reference: unknown) => {
            if (reference === internal.auth.billing.deductCreditsFromGateway) {
                throw new Error("ledger unavailable");
            }

            return true;
        });

        await expect(runBilledVideo(failing, executionContextOf(), videoNode, "u1", costs(), async () => "clip")).resolves.toBe("clip");
    });
});

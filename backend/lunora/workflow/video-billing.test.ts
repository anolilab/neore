import { MODEL_LOOKUP, type ModelDefinition } from "@neore/ai/models";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import type { WorkflowNode } from "./core";
import { runBilledVideo, workflowVideoErrors } from "./video-billing";
import { executionContextOf } from "./test-execution-context";
import type { RunAccount } from "./run-setup";

/** A registry row the tests name by id. A missing row fails here, not as a vacuous pass. */
const row = (id: string): ModelDefinition => {
    const definition = MODEL_LOOKUP.get(id);

    if (!definition) {
        throw new Error(`fixture ${id} is not in the registry`);
    }

    return definition;
};

/** Paid-plan and priced: 5 s at its rate is the cost of a default clip. */
const PAID = "fal-ai/luma-dream-machine/ray-2";
/** The free default, with no price. */
const FREE = "fal-ai/ltx-video";

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
const rate = row(PAID).costPerSecondMicrodollars ?? 0;

describe("workflowVideoErrors", () => {
    it("refuses a guest, before any node runs", () => {
        expect(workflowVideoErrors(account({ isAnonymous: true }), [videoNode])).toStrictEqual(["Create an account to generate video in a workflow"]);
    });

    it("refuses a paid-plan video model on a free plan, and allows it on a paid plan or for an admin", () => {
        expect(workflowVideoErrors(account(), [videoNode])).toStrictEqual([
            `The "Hero" node: ${row(PAID).name} needs a Pro plan. Pick a free model or upgrade.`,
        ]);
        expect(workflowVideoErrors(account({ plan: "premium" }), [videoNode])).toStrictEqual([]);
        expect(workflowVideoErrors(account({ isAdmin: true }), [videoNode])).toStrictEqual([]);
    });

    it("lets the untouched default text-to-video node run, since it needs no paid plan", () => {
        expect(workflowVideoErrors(account(), [node("t", "video", { label: "Untouched", mode: "text-to-video" })])).toStrictEqual([]);
    });
});

describe("runBilledVideo", () => {
    it("takes one unit of the daily video quota for the run's organization, then charges the finished clip once per run and node", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000 });
        const dispatch = vi.fn(async () => "clip");

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", dispatch)).resolves.toBe("clip");

        expect(ctx.runMutation).toHaveBeenCalledWith(internal.chat.daily_charge.chargeDailyUnit, {
            kind: "Video",
            organizationId: "org-1",
            userId: "u1",
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.auth.billing.deductCreditsFromGateway, {
            billingMode: "platform",
            costMicrodollars: 5 * rate,
            modelId: PAID,
            orgId: "org-1",
            requestId: "workflow-video:run:gen",
            userId: "u1",
        });
    });

    it("refuses a clip the account has no credits left for, before the quota or any paid call", async () => {
        // 5 s at the row's rate costs 600 credits (1 credit = 1,000 microdollars).
        const ctx = makeCtx({ creditsLeft: 100 });
        const dispatch = vi.fn(async () => "clip");

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", dispatch)).rejects.toThrow(
            'Not enough credits for the "Hero" video',
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it("refuses when the daily quota is spent, before any paid call", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000, limitOk: false });
        const dispatch = vi.fn(async () => "clip");

        await expect(runBilledVideo(ctx, executionContextOf(), videoNode, "u1", dispatch)).rejects.toThrow("daily video generation limit");
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("charges nothing for a clip whose generation failed", async () => {
        const ctx = makeCtx({ creditsLeft: 10_000 });

        await expect(
            runBilledVideo(ctx, executionContextOf(), videoNode, "u1", async () => {
                throw new Error("fal is down");
            }),
        ).rejects.toThrow("fal is down");
        expect(ctx.runMutation.mock.calls.some(([reference]) => reference === internal.auth.billing.deductCreditsFromGateway)).toBe(false);
    });

    it("does not refuse for a member with no credit record, and does not check credits for an unpriced model", async () => {
        const noRecord = makeCtx({ creditsLeft: null });

        await runBilledVideo(noRecord, executionContextOf(), videoNode, "u1", async () => "clip");
        expect(noRecord.runMutation).toHaveBeenCalledWith(internal.chat.daily_charge.chargeDailyUnit, expect.anything());

        const unpriced = makeCtx({ creditsLeft: 0 });

        await runBilledVideo(unpriced, executionContextOf(), node("g", "video", { mode: "text-to-video", model: FREE }), "u1", async () => "clip");
        expect(unpriced.runQuery).not.toHaveBeenCalled();
    });

    it("charges nothing without an organization, and keeps a finished clip when its charge cannot be recorded", async () => {
        const noOrg = makeCtx();

        await runBilledVideo(noOrg, executionContextOf({ orgId: undefined }), videoNode, "u1", async () => "clip");
        expect(noOrg.runMutation.mock.calls.some(([reference]) => reference === internal.auth.billing.deductCreditsFromGateway)).toBe(false);

        const failing = makeCtx();

        failing.runMutation.mockImplementation(async (reference: unknown) => {
            if (reference === internal.auth.billing.deductCreditsFromGateway) {
                throw new Error("ledger unavailable");
            }

            return true;
        });

        await expect(runBilledVideo(failing, executionContextOf(), videoNode, "u1", async () => "clip")).resolves.toBe("clip");
    });
});

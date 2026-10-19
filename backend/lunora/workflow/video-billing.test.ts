import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { deductCreditsFromGateway, releaseGatewayCredits, reserveGatewayCredits } from "../auth/billing";
import schema from "../schema";
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
        if (reference === internal.auth.billing.reserveGatewayCredits) {
            return "taken";
        }

        if (reference === internal.chat.daily_charge.chargeDailyUnit) {
            return limitOk;
        }

        return undefined;
    });

    return { runMutation, runQuery };
};

/** The request id of the clip charge for run `run` and node `gen`. */
const REQUEST_ID = 'workflow-video:["run","gen"]';

/**
 * A deduction ledger keyed on the request id, as `applyGatewayDeduction` is: a repeat of a request id posts nothing.
 * `deductFailures` makes the first deductions throw; `recordFails` makes the claim write throw.
 */
const ledgerCtx = ({ deductFailures = 0, recordFails = false }: { deductFailures?: number; recordFails?: boolean } = {}) => {
    const ledger = new Map<string, number>();
    const posted: string[] = [];
    const deductions: Record<string, unknown>[] = [];
    const claims: unknown[] = [];
    let failures = deductFailures;
    const runMutation = vi.fn(async (reference: unknown, args?: any) => {
        if (reference === internal.auth.billing.deductCreditsFromGateway) {
            deductions.push(args);

            if (failures > 0) {
                failures -= 1;

                throw new Error("ledger unavailable");
            }

            if (!ledger.has(args.requestId)) {
                ledger.set(args.requestId, args.costMicrodollars);
                posted.push(args.requestId);
            }

            return undefined;
        }

        if (reference === internal.lib.claim_once.claimKey) {
            if (recordFails) {
                throw new Error("claims unavailable");
            }

            claims.push(args);

            return true;
        }

        if (reference === internal.auth.billing.reserveGatewayCredits) {
            return "taken";
        }

        if (reference === internal.chat.daily_charge.chargeDailyUnit) {
            return true;
        }

        return undefined;
    });
    const runQuery = vi.fn(async () => {
        return { creditsLeft: null };
    });

    return { claims, deductions, ledger, posted, runMutation, runQuery };
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

    it("charges nothing without an organization", async () => {
        const noOrg = makeCtx();

        await runBilledVideo(noOrg, executionContextOf({ orgId: undefined }), videoNode, "u1", costs(), async () => "clip");
        expect(noOrg.runMutation.mock.calls.some(([reference]) => reference === internal.auth.billing.deductCreditsFromGateway)).toBe(false);
    });

    it("retries a failed deduction once, with the same request id, and records nothing when the retry lands", async () => {
        const ctx = ledgerCtx({ deductFailures: 1 });

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => "clip")).resolves.toBe("clip");

        expect(ctx.deductions).toHaveLength(2);
        expect(ctx.deductions.map((args) => args.requestId)).toStrictEqual([REQUEST_ID, REQUEST_ID]);
        expect(ctx.claims).toStrictEqual([]);
        expect(ctx.posted).toStrictEqual([REQUEST_ID]);
    });

    it("records a charge that failed twice for the next sweep, and still returns the finished clip", async () => {
        const ctx = ledgerCtx({ deductFailures: 2 });

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => "clip")).resolves.toBe("clip");

        expect(ctx.deductions).toHaveLength(2);
        expect(ctx.posted).toStrictEqual([]);
        expect(ctx.claims).toStrictEqual([
            {
                key: REQUEST_ID,
                leaseMs: 60_000,
                onLapse: {
                    args: JSON.stringify({
                        billingMode: "platform",
                        costMicrodollars: CLIP,
                        modelId: PAID,
                        orgId: "org-1",
                        requestId: REQUEST_ID,
                        userId: "u1",
                    }),
                    target: internal.auth.billing.deductCreditsFromGateway.__lunoraRef,
                },
                scope: "video-charge",
                ttlMs: 24 * 60 * 60 * 1000,
                userId: "u1",
            },
        ]);
    });

    it("completes a recorded charge once when the sweep lapses it, and a repeat sweep charges nothing more", async () => {
        const ctx = ledgerCtx({ deductFailures: 2 });

        await runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => "clip");

        // The sweep (`reapLapsedClaims`) runs the record's target with its args and the claim key.
        const [record] = ctx.claims as { key: string; onLapse: { args: string; target: string } }[];
        const sweep = async () =>
            await ctx.runMutation(internal.auth.billing.deductCreditsFromGateway, { ...JSON.parse(record!.onLapse.args), claimKey: record!.key });

        await sweep();
        await sweep();

        expect(ctx.posted).toStrictEqual([REQUEST_ID]);
        expect(ctx.ledger.get(REQUEST_ID)).toBe(CLIP);
    });

    it("keeps the finished clip even when the record of a failed charge cannot be written", async () => {
        const ctx = ledgerCtx({ deductFailures: 2, recordFails: true });

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => "clip")).resolves.toBe("clip");
        expect(ctx.posted).toStrictEqual([]);
    });
});

describe("the recorded charge's lapse target", () => {
    it("accepts the sweep's extra claim key, so a lapse is not refused by the deduction's input check", async () => {
        const harness = lunoraTest(schema as never);

        try {
            // `reapLapsedClaims` runs the target with its onLapse args plus `claimKey`; the procedure must take that.
            await expect(
                harness.run(
                    async (ctx: any) =>
                        await ctx.runMutation(deductCreditsFromGateway, { claimKey: "k", costMicrodollars: 1, modelId: "m", requestId: "r", userId: "u" }),
                ),
            ).resolves.toBeUndefined();
        } finally {
            harness.close();
        }
    });
});

/**
 * One member's balance, taken the way `reserveGatewayCredits` takes it: the check and the take in one step. Every
 * `creditsLeft` read answers the full balance, as two runs that start together both read it before either reserves.
 */
const balanceCtx = ({
    balance,
    quotaFails = false,
    quotaOk = true,
    releaseFailures = 0,
}: {
    balance: number;
    quotaFails?: boolean;
    quotaOk?: boolean;
    releaseFailures?: number;
}) => {
    let left = balance;
    let failuresLeft = releaseFailures;
    const reserved = new Map<string, number>();
    const runMutation = vi.fn(async (reference: unknown, args?: any) => {
        if (reference === internal.auth.billing.reserveGatewayCredits) {
            if (reserved.has(args.requestId)) {
                return "already";
            }

            // 1 credit is 1,000 microdollars.
            const credits = args.costMicrodollars / 1000;

            if (credits > left) {
                return "refused";
            }

            left -= credits;
            reserved.set(args.requestId, credits);

            return "taken";
        }

        if (reference === internal.auth.billing.releaseGatewayCredits) {
            if (failuresLeft > 0) {
                failuresLeft -= 1;

                throw new Error("ledger unavailable");
            }

            left += reserved.get(args.requestId) ?? 0;
            reserved.delete(args.requestId);

            return undefined;
        }

        if (reference === internal.chat.daily_charge.chargeDailyUnit) {
            if (quotaFails) {
                throw new Error("quota unavailable");
            }

            return quotaOk;
        }

        return undefined;
    });
    const runQuery = vi.fn(async () => {
        return { creditsLeft: balance };
    });

    return { left: () => left, runMutation, runQuery };
};

describe("the clip's credit reservation", () => {
    it("refuses the second of two runs racing for a balance that covers one clip, before its paid call", async () => {
        const ctx = balanceCtx({ balance: 600 });
        const dispatchA = vi.fn(async () => "clip-a");
        const dispatchB = vi.fn(async () => "clip-b");

        const results = await Promise.allSettled([
            runBilledVideo(ctx, executionContextOf({ orgId: "org-1", runId: "run-a" }), videoNode, "u1", costs(), dispatchA),
            runBilledVideo(ctx, executionContextOf({ orgId: "org-1", runId: "run-b" }), videoNode, "u1", costs(), dispatchB),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(dispatchA.mock.calls.length + dispatchB.mock.calls.length).toBe(1);
        const refusal = results.find((result): result is PromiseRejectedResult => result.status === "rejected");

        expect(refusal?.reason).toBeInstanceOf(Error);
        expect((refusal?.reason as Error).message).toContain("Not enough credits");
        expect(ctx.left()).toBe(100);
    });

    it("gives the reservation back when the paid work makes no clip", async () => {
        const ctx = balanceCtx({ balance: 1000 });

        await expect(
            runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => {
                throw new Error("fal is down");
            }),
        ).rejects.toThrow("fal is down");
        expect(ctx.left()).toBe(1000);
    });

    it("gives the reservation back when the daily quota call throws, not only when it refuses", async () => {
        const ctx = balanceCtx({ balance: 1000, quotaFails: true });

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => "clip")).rejects.toThrow(
            "quota unavailable",
        );
        expect(ctx.left()).toBe(1000);
    });

    it("retries a release that fails once, so the reservation is still given back", async () => {
        const ctx = balanceCtx({ balance: 1000, releaseFailures: 1 });

        await expect(
            runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => {
                throw new Error("fal is down");
            }),
        ).rejects.toThrow("fal is down");
        expect(ctx.left()).toBe(1000);
    });

    it("does not give back an earlier attempt's reservation when a retry of the node fails", async () => {
        const ctx = balanceCtx({ balance: 1000 });
        const run = executionContextOf({ orgId: "org-1", runId: "run-a" });

        await expect(runBilledVideo(ctx, run, videoNode, "u1", costs(), async () => "clip")).resolves.toBe("clip");
        expect(ctx.left()).toBe(500);

        await expect(
            runBilledVideo(ctx, run, videoNode, "u1", costs(), async () => {
                throw new Error("fal is down");
            }),
        ).rejects.toThrow("fal is down");
        expect(ctx.left()).toBe(500);
    });

    it("gives the reservation back when the daily quota refuses the run", async () => {
        const ctx = balanceCtx({ balance: 1000, quotaOk: false });

        await expect(runBilledVideo(ctx, executionContextOf({ orgId: "org-1" }), videoNode, "u1", costs(), async () => "clip")).rejects.toThrow(
            "daily video generation limit",
        );
        expect(ctx.left()).toBe(1000);
    });
});

describe("the clip's reservation against the real ledger", () => {
    it("takes a clip within the balance, refuses one past it, gives a release back once, and posts nothing after", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const observed = await harness.run(async (ctx: any) => {
                // 1,000 credits: one credit is 1,000 microdollars.
                const orgId = await ctx.db.insert("organization", { createdAt: Date.now(), name: "Org", slug: "org" });

                await ctx.db.insert("memberCredits", { creditOverride: 1000, memberId: "member-1", organizationId: orgId, usedCredits: 0, userId: "u1" });

                const usedCredits = async (): Promise<number> => {
                    const record = await ctx.db.memberCredits.findFirst({ where: { organizationId: orgId, userId: "u1" } });

                    return (record as { usedCredits?: number }).usedCredits ?? 0;
                };
                const reserve = async (costMicrodollars: number, requestId: string): Promise<boolean> =>
                    await ctx.runMutation(reserveGatewayCredits, { costMicrodollars, modelId: PAID, orgId, requestId, userId: "u1" });
                const ledgerRowOf = async (requestId: string): Promise<unknown> =>
                    await ctx.db
                        .query("gatewayUsageDeductions")
                        .withIndex("by_requestId", (q: any) => q.eq("requestId", requestId))
                        .first();

                const first = await reserve(500_000, "r-1");
                const afterFirst = await usedCredits();
                const second = await reserve(500_000, "r-2");
                const afterSecond = await usedCredits();
                const third = await reserve(1000, "r-3");
                const afterRefusal = await usedCredits();

                await ctx.runMutation(releaseGatewayCredits, { requestId: "r-1" });
                const afterRelease = await usedCredits();
                const rowAfterRelease = await ledgerRowOf("r-1");

                await ctx.runMutation(releaseGatewayCredits, { requestId: "r-1" });
                const afterSecondRelease = await usedCredits();

                return { afterFirst, afterRefusal, afterRelease, afterSecond, afterSecondRelease, first, rowAfterRelease, second, third };
            });

            expect(observed).toMatchObject({
                afterFirst: 500,
                afterRefusal: 1000,
                afterRelease: 500,
                afterSecond: 1000,
                first: "taken",
                second: "taken",
                third: "refused",
            });
            expect(observed.rowAfterRelease).toBeFalsy();
            expect(observed.afterSecondRelease).toBe(500);
        } finally {
            harness.close();
        }
    });

    it("refuses a negative cost, so a reservation can never take nothing and pass", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await expect(
                harness.run(
                    async (ctx: any) =>
                        await ctx.runMutation(reserveGatewayCredits, { costMicrodollars: -1, modelId: PAID, orgId: "org-1", requestId: "r-neg", userId: "u1" }),
                ),
            ).rejects.toThrow();
        } finally {
            harness.close();
        }
    });
});

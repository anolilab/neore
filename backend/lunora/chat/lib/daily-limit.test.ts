import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { RATE_LIMIT_CONFIGS } from "../../lib/rate-limiter";
import { runInShard } from "../../lib/shard-context";
import {
    chargeDailyLimit,
    dailyLimitKeyOf,
    dailyLimitTierOf,
    type DailyLimitKind,
    type DailyLimitTier,
    rateLimitTierOf,
    refundDailyLimit,
} from "./daily-limit";
import { mediaThreadTitle, startTitleJobs } from "./start-title-jobs";

const crossShard = vi.hoisted(() => {
    return { calls: [] as { args: unknown; reference: unknown; shardKey: string }[] };
});

vi.mock("../../lib/cross-shard", () => {
    return {
        callOnShard: async (reference: unknown, args: unknown, options: { shardKey: string }) => {
            crossShard.calls.push({ args, reference, shardKey: options.shardKey });

            return { ok: true };
        },
    };
});

const runnerReturning = (result: { ok: boolean; retryAfter?: number }) => {
    const runMutation = vi.fn(async (_reference: unknown, _args: { count?: number; identifier: string; key: string }) => result);

    return { context: { runMutation } as never, runMutation };
};

describe("tiered per-minute limits on HTTP routes (e.g. /workflow/stream)", () => {
    it("gives the paid plan and admins premium, everyone else free", () => {
        expect(rateLimitTierOf({ plan: "premium" })).toBe("premium");
        expect(rateLimitTierOf({ role: "admin" })).toBe("premium");
        expect(rateLimitTierOf({ plan: null, role: "user" })).toBe("free");
        expect(rateLimitTierOf({})).toBe("free");
    });
});

describe("daily limits", () => {
    it("resolves guests, then the paid plan, then free", () => {
        expect(dailyLimitTierOf({ isAnonymous: true, plan: "premium" })).toBe("anonymous");
        expect(dailyLimitTierOf({ plan: "premium" })).toBe("premium");
        expect(dailyLimitTierOf({ plan: null })).toBe("free");
        expect(dailyLimitTierOf({})).toBe("free");
    });

    it("names only configs that exist", () => {
        for (const kind of ["Audio", "Image", "Text", "Video"] satisfies DailyLimitKind[]) {
            for (const tier of ["anonymous", "free", "premium"] satisfies DailyLimitTier[]) {
                const key = dailyLimitKeyOf(kind, tier);

                if (key !== undefined) {
                    expect(Object.hasOwn(RATE_LIMIT_CONFIGS, key)).toBe(true);
                }
            }
        }
    });

    it("charges a premium user to the premium quota", async () => {
        const { context, runMutation } = runnerReturning({ ok: true });

        expect(await chargeDailyLimit(context, { _id: "u1", plan: "premium" }, "Text")).toEqual({ ok: true });
        expect(runMutation.mock.calls[0]?.[1]).toEqual({ count: 1, identifier: "u1", key: "chat/dailyText:premium" });

        await chargeDailyLimit(context, { _id: "u1", plan: "premium" }, "Image", 3);
        expect(runMutation.mock.calls[1]?.[1]).toEqual({ count: 3, identifier: "u1", key: "chat/dailyImage:premium" });
    });

    it("charges a user without a plan to the free quota", async () => {
        const { context, runMutation } = runnerReturning({ ok: true });

        await chargeDailyLimit(context, { _id: "u2", plan: null }, "Text");
        expect(runMutation.mock.calls[0]?.[1]).toMatchObject({ key: "chat/dailyText:free" });
    });

    it("exempts platform admins without touching the limiter", async () => {
        const { context, runMutation } = runnerReturning({ ok: false });

        expect(await chargeDailyLimit(context, { _id: "a", role: "admin" }, "Video")).toEqual({ ok: true });
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("refuses a tier with no quota for the kind instead of letting it through", async () => {
        const { context, runMutation } = runnerReturning({ ok: true });

        expect(await chargeDailyLimit(context, { _id: "g", isAnonymous: true }, "Video")).toEqual({ ok: false });
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("passes the limiter's refusal through", async () => {
        const { context } = runnerReturning({ ok: false, retryAfter: 42 });

        expect(await chargeDailyLimit(context, { _id: "u" }, "Text")).toEqual({ ok: false, retryAfter: 42 });
    });

    it("charges a member on their own shard when the work runs on the owner's, so a shared chat draws on one counter", async () => {
        crossShard.calls.length = 0;
        const { context, runMutation } = runnerReturning({ ok: true });

        await runInShard("owner-1", async () => {
            expect(await chargeDailyLimit(context, { _id: "member-1", plan: null }, "Image")).toEqual({ ok: true });
        });

        expect(runMutation).not.toHaveBeenCalled();
        expect(crossShard.calls).toStrictEqual([
            {
                args: { count: 1, identifier: "member-1", key: "chat/dailyImage:free" },
                reference: internal.lib.rate_limiter_mutations.applyRateLimit,
                shardKey: "member-1",
            },
        ]);
    });

    it("keeps a charge on the user's own shard local, with no crossing", async () => {
        crossShard.calls.length = 0;
        const { context, runMutation } = runnerReturning({ ok: true });

        await runInShard("member-1", async () => {
            await chargeDailyLimit(context, { _id: "member-1", plan: "premium" }, "Text");
        });

        expect(runMutation).toHaveBeenCalledTimes(1);
        expect(crossShard.calls).toHaveLength(0);
    });

    it("gives a refund back on the same shard as the charge it undoes", async () => {
        crossShard.calls.length = 0;
        const { context, runMutation } = runnerReturning({ ok: true });

        await runInShard("owner-1", async () => {
            await refundDailyLimit(context, { _id: "member-1", plan: null }, "Image", { windowStart: 7 });
        });

        expect(runMutation).not.toHaveBeenCalled();
        expect(crossShard.calls).toMatchObject([
            { args: { count: 1, identifier: "member-1", key: "chat/dailyImage:free", windowStart: 7 }, shardKey: "member-1" },
        ]);
    });
});

describe("/chat/start title jobs", () => {
    it("schedules no paid title or category call for a media prompt", () => {
        expect(startTitleJobs("image", true)).toEqual([]);
        expect(startTitleJobs("video", false)).toEqual([]);
        expect(startTitleJobs("text", true)).toEqual(["title", "category"]);
        expect(startTitleJobs("text", false)).toEqual(["title"]);
    });

    it("titles a media thread from its prompt", () => {
        expect(mediaThreadTitle("  a   red\nfox ")).toBe("a red fox");
        expect(mediaThreadTitle(undefined)).toBeUndefined();
        expect(mediaThreadTitle(" ".repeat(3))).toBeUndefined();
        expect(mediaThreadTitle("x".repeat(100))).toHaveLength(60);
    });
});

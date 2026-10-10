import { describe, expect, it, vi } from "vitest";

import { RATE_LIMIT_CONFIGS } from "../../lib/rate-limiter";
import { chargeDailyLimit, dailyLimitKeyOf, dailyLimitTierOf, type DailyLimitKind, type DailyLimitTier, rateLimitTierOf } from "./daily-limit";
import { mediaThreadTitle, startTitleJobs } from "./start-title-jobs";

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

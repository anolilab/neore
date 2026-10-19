import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { HonoEnv } from "../env.js";
import { capsFor, dailyLimitMiddleware, parseTierLimits, secondsUntilUtcMidnight } from "../middleware/daily-limit.js";

/** A D1 double whose `usage_log` aggregate answers `usage`, or fails when it is `null`. */
const makeDb = (usage: { requests: number; tokens: number; tokensLastMinute?: number } | null) => {
    const first = vi.fn(async () => {
        if (usage === null) {
            throw new Error("d1 down");
        }

        return usage;
    });
    const bind = vi.fn(() => {
        return { first };
    });
    const prepare = vi.fn(() => {
        return { bind };
    });

    return { db: { prepare } as unknown as D1Database, prepare };
};

const makeApp = (tier = "free", userId: string | undefined = "user-1") => {
    const app = new Hono<HonoEnv>();

    app.use("*", async (c, next) => {
        if (userId) {
            c.set("userId", userId);
        }

        c.set("userTier", tier);
        await next();
    });
    app.use("*", dailyLimitMiddleware);
    app.post("/chat", (c) => c.json({ ok: true }));

    return app;
};

const statusOf = async (app: ReturnType<typeof makeApp>, env: Record<string, unknown>): Promise<number> => {
    const res = await call(app, env);

    return res.status;
};

const call = (app: ReturnType<typeof makeApp>, env: Record<string, unknown>) =>
    app.fetch(new Request("http://localhost/chat", { method: "POST" }), env as never);

describe("parseTierLimits", () => {
    it("reads tier=limit pairs", () => {
        expect(parseTierLimits("free=200, pro = 5000")).toEqual({ free: 200, pro: 5000 });
    });

    it("ignores what is not a tier and a positive integer", () => {
        expect(parseTierLimits("free=0,pro=-5,team=abc,=7,enterprise=1.5,ok=3")).toEqual({ ok: 3 });
        expect(parseTierLimits(undefined)).toEqual({});
        expect(parseTierLimits("")).toEqual({});
    });
});

describe("capsFor", () => {
    it("reads each cap for the tier, and null where none is set", () => {
        expect(capsFor({ DAILY_REQUEST_LIMITS: "free=2", DAILY_TOKEN_LIMITS: "pro=9", TOKENS_PER_MINUTE_LIMITS: "free=20000,pro=200000" }, "free")).toEqual({
            dailyRequests: 2,
            dailyTokens: null,
            tokensPerMinute: 20_000,
        });
        expect(capsFor({}, "pro")).toEqual({ dailyRequests: null, dailyTokens: null, tokensPerMinute: null });
    });
});

describe("secondsUntilUtcMidnight", () => {
    it("counts to the end of the UTC day", () => {
        expect(secondsUntilUtcMidnight(Date.UTC(2026, 9, 19, 23, 59, 30))).toBe(30);
        expect(secondsUntilUtcMidnight(Date.UTC(2026, 9, 19, 0, 0, 0))).toBe(86_400);
    });
});

describe("dailyLimitMiddleware", () => {
    it("does nothing, and reads nothing, when no limit is configured", async () => {
        const { db, prepare } = makeDb({ requests: 9999, tokens: 9_999_999 });
        const res = await call(makeApp(), { USAGE_DB: db });

        expect(res.status).toBe(200);
        expect(prepare).not.toHaveBeenCalled();
    });

    it("lets a request through while under the daily request limit", async () => {
        const { db } = makeDb({ requests: 1, tokens: 0 });

        expect(await statusOf(makeApp(), { DAILY_REQUEST_LIMITS: "free=2", USAGE_DB: db })).toBe(200);
    });

    it("refuses at the daily request limit, with a Retry-After", async () => {
        const { db } = makeDb({ requests: 2, tokens: 0 });
        const res = await call(makeApp(), { DAILY_REQUEST_LIMITS: "free=2", USAGE_DB: db });
        const body = (await res.json()) as { error: { code: string; message: string } };

        expect(res.status).toBe(429);
        expect(body.error.code).toBe("DAILY_LIMIT_EXCEEDED");
        expect(body.error.message).toContain("request limit");
        expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    });

    it("refuses at the daily token limit", async () => {
        const { db } = makeDb({ requests: 1, tokens: 1200 });
        const res = await call(makeApp(), { DAILY_TOKEN_LIMITS: "free=1000", USAGE_DB: db });

        expect(res.status).toBe(429);
        expect(((await res.json()) as { error: { message: string } }).error.message).toContain("token limit");
    });

    it("applies the limit of the caller's own tier", async () => {
        const { db } = makeDb({ requests: 5, tokens: 0 });
        const env = { DAILY_REQUEST_LIMITS: "free=1", USAGE_DB: db };

        expect(await statusOf(makeApp("free"), env)).toBe(429);
        expect(await statusOf(makeApp("pro"), env)).toBe(200);
    });

    it("refuses at the per-minute token cap, with a 60 second Retry-After and its own code", async () => {
        const { db } = makeDb({ requests: 1, tokens: 500, tokensLastMinute: 20_000 });
        const res = await call(makeApp(), { TOKENS_PER_MINUTE_LIMITS: "free=20000", USAGE_DB: db });
        const body = (await res.json()) as { error: { code: string; message: string } };

        expect(res.status).toBe(429);
        expect(body.error.code).toBe("TOKENS_PER_MINUTE_EXCEEDED");
        expect(body.error.message).toContain("per minute");
        expect(res.headers.get("Retry-After")).toBe("60");
    });

    it("lets a request through under the per-minute cap, even at the day's token total", async () => {
        const { db } = makeDb({ requests: 1, tokens: 99_999, tokensLastMinute: 19_999 });

        expect(await statusOf(makeApp(), { TOKENS_PER_MINUTE_LIMITS: "free=20000", USAGE_DB: db })).toBe(200);
    });

    it("lets a request through when the usage cannot be read, and logs why", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { db } = makeDb(null);

        expect(await statusOf(makeApp(), { DAILY_REQUEST_LIMITS: "free=1", USAGE_DB: db })).toBe(200);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[llm-gateway]"), expect.stringContaining("usage read failed"), expect.any(Error));

        errorSpy.mockRestore();
    });
});

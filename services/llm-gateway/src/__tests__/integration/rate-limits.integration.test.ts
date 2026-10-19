/**
 * GET /v1/rate-limits (bearer) and GET /internal/admin/rate-limits (binding) report the day's
 * counts, the caps of the caller's tier, and the tier's per-minute limit with no count: the
 * native binding cannot be read, so `rpm.current` and `rpm.remaining` are always null.
 * The usage aggregate is answered by the test, the way daily-limit.integration.test.ts does it.
 */
import { describe, expect, it } from "vitest";

import { app } from "../../index.js";
import { bindingEnv, makeInternalRequest } from "../helpers/internal.js";
import { createMockCtx, createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const TOKEN = "gk_rate_limits_integration_test";

const fetchApp = useTrackedAppFetch();

/** The usage aggregate answers `usage` (or throws when it is null); every other statement goes to the mock D1. */
const envWith = async (usage: { requests: number; tokens: number; tokensLastMinute: number } | null, extra: Record<string, string> = {}) => {
    const row = await makeVirtualKeyRow(TOKEN, { tier: "pro" });
    const env = { ...createMockEnv({ apiKeyCacheRows: [row], nodeEnv: "development" }), MOCK_LLM: "1", ...extra };
    const mockDb = env.USAGE_DB;
    const prepare = mockDb.prepare.bind(mockDb);

    mockDb.prepare = ((sql: string) => {
        if (!sql.includes("AS requests")) {
            return prepare(sql);
        }

        if (usage === null) {
            throw new Error("d1 down");
        }

        return {
            bind: () => {
                return { first: async () => usage };
            },
        };
    }) as never;

    return env as never;
};

const status = (env: never) => fetchApp(new Request("http://localhost/v1/rate-limits", { headers: { Authorization: `Bearer ${TOKEN}` } }), env);

describe("GET /v1/rate-limits", () => {
    it("reports the tier's per-minute limit, and no per-minute count, because none can be read", async () => {
        const res = await status(await envWith({ requests: 0, tokens: 0, tokensLastMinute: 0 }));
        const body = (await res.json()) as { rpm: unknown };

        expect(res.status).toBe(200);
        expect(body.rpm).toEqual({ current: null, limit: 120, remaining: null });
    });

    it("reports the day's requests and tokens against the tier's caps, and the last minute's tokens", async () => {
        const res = await status(
            await envWith({ requests: 3, tokens: 400, tokensLastMinute: 120 }, { DAILY_REQUEST_LIMITS: "pro=10", TOKENS_PER_MINUTE_LIMITS: "pro=5000" }),
        );
        const body = (await res.json()) as {
            daily: { requests: { limit: number | null; used: number | null }; tokens: { limit: number | null; used: number | null } };
            tokensPerMinute: { limit: number | null; used: number | null };
        };

        expect(res.status).toBe(200);
        expect(body.daily.requests).toEqual({ limit: 10, used: 3 });
        expect(body.daily.tokens).toEqual({ limit: null, used: 400 });
        expect(body.tokensPerMinute).toEqual({ limit: 5000, used: 120 });
    });

    it("reports null usage, not an error, when the usage cannot be read", async () => {
        const res = await status(await envWith(null, { DAILY_REQUEST_LIMITS: "pro=10" }));
        const body = (await res.json()) as { daily: { requests: { limit: number | null; used: number | null } } };

        expect(res.status).toBe(200);
        expect(body.daily.requests).toEqual({ limit: 10, used: null });
    });
});

describe("GET /v1/rate-limits in the OpenAPI document", () => {
    it("declares rpm.current and rpm.remaining nullable, and rpm.limit not", async () => {
        const res = await app.fetch(new Request("http://localhost/openapi.json"), createMockEnv({ nodeEnv: "development" }) as never, createMockCtx() as never);

        type Rpm = { properties: Record<"current" | "limit" | "remaining", { nullable?: boolean } | undefined> };
        const doc = (await res.json()) as {
            paths: { "/v1/rate-limits": { get: { responses: { 200: { content: { "application/json": { schema: { properties: { rpm: Rpm } } } } } } } } };
        };
        const { rpm } = doc.paths["/v1/rate-limits"].get.responses[200].content["application/json"].schema.properties;

        expect(rpm.properties.current?.nullable).toBe(true);
        expect(rpm.properties.remaining?.nullable).toBe(true);
        expect(rpm.properties.limit?.nullable).toBeUndefined();
    });
});

describe("GET /internal/admin/rate-limits", () => {
    it("answers a binding call with the same shape, for any user and tier", async () => {
        const env = { ...createMockEnv({ nodeEnv: "development" }), MOCK_LLM: "1" };
        const res = await fetchApp(makeInternalRequest("GET", "/internal/admin/rate-limits?userId=user-test-001&tier=free"), bindingEnv(env) as never);
        const body = (await res.json()) as { rpm: unknown; tier: string; userId: string };

        expect(res.status).toBe(200);
        expect(body.userId).toBe("user-test-001");
        expect(body.tier).toBe("free");
        expect(body.rpm).toEqual({ current: null, limit: 20, remaining: null });
    });

    it("is not served to an internet request", async () => {
        const env = { ...createMockEnv({ nodeEnv: "development" }), MOCK_LLM: "1" };
        const res = await fetchApp(makeInternalRequest("GET", "/internal/admin/rate-limits?userId=user-test-001"), env as never);

        expect(res.status).toBe(404);
    });
});

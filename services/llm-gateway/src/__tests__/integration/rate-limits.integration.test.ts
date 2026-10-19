/**
 * GET /v1/rate-limits reports the day's counts and the caps of the caller's tier.
 * The usage aggregate is answered by the test, the way daily-limit.integration.test.ts does it.
 */
import { describe, expect, it } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
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

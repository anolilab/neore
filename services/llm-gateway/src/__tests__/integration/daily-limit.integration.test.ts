/**
 * The daily cap is in the real chain of the public chat route: with a cap
 * configured and the day's usage at it, `/v1/chat/completions` and `/v1/responses`
 * (which dispatches through it) answer 429; unconfigured, nothing changes.
 */
import { describe, expect, it } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const TOKEN = "gk_daily_limit_integration_test";

const fetchApp = useTrackedAppFetch();

/** `usage_log` aggregate queries answer `usage`; every other statement goes to the mock D1. */
const makeEnv = async (extra: Record<string, string>, usage: { requests: number; tokens: number }) => {
    const row = await makeVirtualKeyRow(TOKEN, { tier: "free" });
    const env = { ...createMockEnv({ apiKeyCacheRows: [row], nodeEnv: "development" }), MOCK_LLM: "1", ...extra };
    const mockDb = env.USAGE_DB;
    const prepare = mockDb.prepare.bind(mockDb);

    mockDb.prepare = ((sql: string) =>
        sql.includes("AS requests")
            ? {
                  bind: () => {
                      return { first: async () => usage };
                  },
              }
            : prepare(sql)) as never;

    return env as never;
};

const post = (path: string, body: unknown): Request =>
    new Request(`http://localhost${path}`, {
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
    });

const chat = () => post("/v1/chat/completions", { messages: [{ content: "ping", role: "user" }], model: "mock/echo" });

const withKey = (request: Request, key: string): Request => {
    request.headers.set("Idempotency-Key", key);

    return request;
};
const responses = () => post("/v1/responses", { input: "ping", model: "mock/echo" });

describe("daily cap on the public chat route", () => {
    it("refuses a chat request once the day's usage is at the cap", async () => {
        const res = await fetchApp(chat(), await makeEnv({ DAILY_REQUEST_LIMITS: "free=3" }, { requests: 3, tokens: 0 }));

        expect(res.status).toBe(429);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DAILY_LIMIT_EXCEEDED");
    });

    it("lets it through while under the cap", async () => {
        const res = await fetchApp(chat(), await makeEnv({ DAILY_REQUEST_LIMITS: "free=3" }, { requests: 2, tokens: 0 }));

        expect(res.status).toBe(200);
    });

    it("applies to /v1/responses through the chat request it makes", async () => {
        const res = await fetchApp(responses(), await makeEnv({ DAILY_TOKEN_LIMITS: "free=100" }, { requests: 1, tokens: 100 }));

        expect(res.status).toBe(429);
    });

    it("replays a completed call with its Idempotency-Key even once the day is at the cap", async () => {
        const usage = { requests: 2, tokens: 0 };
        const env = await makeEnv({ DAILY_REQUEST_LIMITS: "free=3" }, usage);
        const first = await fetchApp(withKey(chat(), "replay-at-cap"), env);

        expect(first.status).toBe(200);

        // The day's last allowed call has now been spent: the stub reports the cap.
        usage.requests = 3;

        const replay = await fetchApp(withKey(chat(), "replay-at-cap"), env);

        expect(replay.status).toBe(200);
        expect(replay.headers.get("X-Idempotency-Replayed")).toBe("true");

        const fresh = await fetchApp(withKey(chat(), "a-new-key"), env);

        expect(fresh.status).toBe(429);
    });

    it("changes nothing when no cap is configured", async () => {
        const res = await fetchApp(chat(), await makeEnv({}, { requests: 9999, tokens: 9_999_999 }));

        expect(res.status).toBe(200);
    });
});

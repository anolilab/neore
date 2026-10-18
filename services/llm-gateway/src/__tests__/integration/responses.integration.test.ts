/**
 * POST /v1/responses through the real app (`src/index.ts`), with the completions
 * route behind it and the mock model in place of a provider.
 *
 * Pins two things the dispatch wiring must keep: the user's per-minute limit is
 * counted once for the chat request this route makes, and a non-streaming tool
 * call comes back as a `function_call` item rather than an empty message.
 */
import { describe, expect, it } from "vitest";

import { createMockEnv, makeVirtualKeyRow } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const TOKEN = "gk_responses_integration_test";
// Free tier: 20 requests per minute, counted on the native binding for the "chat" family.
const FREE_LIMIT = 20;
const RATE_KEY = "RATE_LIMIT_20:chat:user-test-001";

const fetchApp = useTrackedAppFetch();

const envWithUsed = async (used: number) => {
    const row = await makeVirtualKeyRow(TOKEN, { tier: "free" });

    return { ...createMockEnv({ apiKeyCacheRows: [row], nodeEnv: "development", rateLimitUsed: { [RATE_KEY]: used } }), MOCK_LLM: "1" } as never;
};

const responsesRequest = (body: unknown): Request =>
    new Request("http://localhost/v1/responses", {
        body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
    });

describe("POST /v1/responses through the real app", () => {
    it("counts the dispatched chat request against the rate limit once", async () => {
        // One request left in the minute: it must pass. Counted twice, the second count would be refused.
        const res = await fetchApp(responsesRequest({ input: "ping", model: "mock/echo" }), await envWithUsed(FREE_LIMIT - 1));

        expect(res.status).toBe(200);
    });

    it("refuses once the limit is reached, so the limit is enforced on this route at all", async () => {
        const res = await fetchApp(responsesRequest({ input: "ping", model: "mock/echo" }), await envWithUsed(FREE_LIMIT));

        expect(res.status).toBe(429);
    });

    it("answers a plain non-streaming request with the mock model's text", async () => {
        const res = await fetchApp(responsesRequest({ input: "ping", model: "mock/echo" }), await envWithUsed(0));
        const body = (await res.json()) as { output: { content?: { text: string }[]; type: string }[]; status: string };

        expect(body.status).toBe("completed");
        expect(body.output[0].type).toBe("message");
        expect(body.output[0].content?.[0].text).toContain("Mock reply");
    });

    it("returns a non-streaming tool call as a function_call item", async () => {
        const res = await fetchApp(
            responsesRequest({
                input: 'Weather in Oslo? [[tool:get_weather {"city":"Oslo"}]]',
                model: "mock/echo",
                tools: [{ name: "get_weather", parameters: { type: "object" }, type: "function" }],
            }),
            await envWithUsed(0),
        );

        expect(res.status).toBe(200);

        const body = (await res.json()) as { output: { arguments?: string; name?: string; type: string }[] };
        const call = body.output.find((item) => item.type === "function_call");

        expect(call?.name).toBe("get_weather");
        expect(JSON.parse(call?.arguments ?? "null")).toEqual({ city: "Oslo" });
    });
});

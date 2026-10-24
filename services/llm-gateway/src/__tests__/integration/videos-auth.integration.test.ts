/**
 * videos-auth.integration.test.ts
 *
 * `POST /v1/videos` (bare path) must sit behind bearerAuth: the router guard
 * is registered on `/v1/videos/*`, and this pins that it covers the bare path.
 */
import { describe, expect, it, vi } from "vitest";

import { createMockEnv } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        generateText: vi.fn().mockResolvedValue({
            finishReason: "stop",
            text: "ok",
            toolCalls: [],
            usage: { completionTokens: 1, promptTokens: 1 },
        }),
    };
});

// Spread the real module rather than listing its exports: a hand-written
// export list goes stale the moment production adds one, and the failure
// surfaces as a 502 from an unrelated endpoint rather than as a missing mock.
vi.mock("../../providers/factory.js", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../providers/factory.js")>()),
        createKeyPool: vi.fn(),
        createProviderModel: vi.fn().mockResolvedValue({ modelId: "mock", provider: "mock" }),
        resolveApiKey: vi.fn().mockReturnValue("test-api-key"),
        resolveApiKeys: vi.fn().mockReturnValue(["test-api-key"]),
    };
});

const fetchApp = useTrackedAppFetch();

const post = (headers: Record<string, string>): Request =>
    new Request("http://localhost/v1/videos", {
        body: JSON.stringify({ model: "any", prompt: "a cat" }),
        headers: { "Content-Type": "application/json", ...headers },
        method: "POST",
    });

describe("POST /v1/videos authentication", () => {
    it("returns 401 without an Authorization header", async () => {
        const res = await fetchApp(post({}), createMockEnv());

        expect(res.status).toBe(401);
    });

    it("returns 401 for an unknown key", async () => {
        const res = await fetchApp(post({ Authorization: "Bearer gk_unknown" }), createMockEnv());

        expect(res.status).toBe(401);
    });
});

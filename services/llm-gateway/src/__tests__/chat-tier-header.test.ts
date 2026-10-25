/**
 * POST /v1/chat does not forward `x-gateway-tier`. The backend never reads it
 * on `/chat/start`, so passing it on would only look like an override.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HonoEnv } from "../env.js";
import { chatRouter } from "../routes/v1/chat.js";
import { createMockCtx, createMockEnv } from "./helpers/mock-env.js";

const mockFetch = vi.fn();

beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => Response.json({ threadId: "t1" }));
    vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const app = new Hono<HonoEnv>().route("/", chatRouter);

const startChat = async (extraHeaders: Record<string, string> = {}) =>
    app.fetch(
        new Request("http://localhost/v1/chat", {
            body: JSON.stringify({ model: "gpt-4o-mini", prompt: "hi" }),
            headers: { Authorization: "Bearer jwt", "Content-Type": "application/json", ...extraHeaders },
            method: "POST",
        }),
        { ...createMockEnv(), PUBLIC_GATEWAY_URL: "https://gateway.test" },
        createMockCtx(),
    );

const forwardedHeaders = () => new Headers((mockFetch.mock.calls[0] as [string, RequestInit])[1].headers);

describe("POST /v1/chat x-gateway-tier", () => {
    it("does not forward the header, whatever its value", async () => {
        for (const value of ["reasoning", "not-a-tier"]) {
            mockFetch.mockClear();
            const res = await startChat({ "x-gateway-tier": value });

            expect(res.status).toBe(200);
            expect(mockFetch).toHaveBeenCalledOnce();
            expect(forwardedHeaders().has("x-gateway-tier")).toBe(false);
        }
    });

    it("answers a request without the header as before", async () => {
        const res = await startChat();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ gatewayUrl: "https://gateway.test", threadId: "t1" });
        expect(forwardedHeaders().get("authorization")).toBe("Bearer jwt");
        expect(forwardedHeaders().has("x-signature")).toBe(true);
    });
});

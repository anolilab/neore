/**
 * Unit tests for middleware/idempotency.ts
 *
 * Uses app.fetch(req, env, ctx) pattern so that c.env and c.executionCtx
 * are properly populated — matching real Cloudflare Workers behaviour.
 *
 * Tests cover:
 *   - Pass-through when no Idempotency-Key header
 *   - First request (cache miss): calls handler, caches response in KV
 *   - Deduplication: second request with same key returns cached response
 *   - X-Idempotency-Replayed header on replayed responses
 *   - User scoping: same key from different users doesn't interfere
 *   - Streaming bypass: SSE responses not cached
 *   - Expiry simulation: missing KV entry treated as cache miss
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AppEnv, HonoEnv } from "../env.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { createMockEnv, MockKVNamespace } from "./helpers/mock-env.js";

const EVENT_STREAM_CONTENT_TYPE_RE = /text\/event-stream/;

// ---------------------------------------------------------------------------
// Awaiting execution context — waitUntil actually awaits promises in tests
// ---------------------------------------------------------------------------

function createAwaitingContext() {
    const pending: Promise<unknown>[] = [];

    return {
        async flush() {
            await Promise.allSettled(pending);
            pending.length = 0;
        },
        passThroughOnException() {},
        waitUntil(promise: Promise<unknown>) {
            pending.push(promise);
        },
    };
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

interface AppSetup {
    app: Hono<HonoEnv>;
    cacheKv: MockKVNamespace;
    callCount: { value: number };
    fetch: (
        requestInit: { idempotencyKey?: string; isStreaming?: boolean; userId?: string },
        context?: ReturnType<typeof createAwaitingContext>,
    ) => Promise<Response>;
}

function buildApp(options: { cacheKv?: MockKVNamespace; env?: Partial<AppEnv>; userId?: string }): AppSetup {
    const cacheKv = options.cacheKv ?? new MockKVNamespace();
    const userId = options.userId ?? "user-123";
    const callCount = { value: 0 };

    const app = new Hono<HonoEnv>();

    // Simulate auth middleware having run
    app.use("/v1/chat/completions", async (c, next) => {
        c.set("userId", userId);
        c.set("requestId", "req-test-id");
        await next();
    });

    app.use("/v1/chat/completions", idempotencyMiddleware);

    app.post("/v1/chat/completions", async (c) => {
        const body = await c.req.json();

        callCount.value++;

        if (body.stream) {
            return new Response("data: [DONE]\n\n", {
                headers: { "Cache-Control": "no-cache", "Content-Type": "text/event-stream" },
            });
        }

        return c.json({
            choices: [{ finish_reason: "stop", index: 0, message: { content: "Hello!", role: "assistant" } }],
            id: "chatcmpl-abc123",
            object: "chat.completion",
            usage: { completion_tokens: 5, prompt_tokens: 10, total_tokens: 15 },
        });
    });

    const mockEnv = createMockEnv({ cacheKv: cacheKv as unknown as MockKVNamespace });

    async function fetchApp(
        requestInit: { idempotencyKey?: string; isStreaming?: boolean; userId?: string },
        context?: ReturnType<typeof createAwaitingContext>,
    ): Promise<Response> {
        const body = JSON.stringify({
            messages: [{ content: "hi", role: "user" }],
            model: "gpt-4o",
            ...(requestInit.isStreaming && { stream: true }),
        });

        const headers: Record<string, string> = { "Content-Type": "application/json" };

        if (requestInit.idempotencyKey) headers["Idempotency-Key"] = requestInit.idempotencyKey;

        const request = new Request("http://localhost/v1/chat/completions", {
            body,
            headers,
            method: "POST",
        });

        const execContext = context ?? createAwaitingContext();

        return app.fetch(request, mockEnv as unknown as AppEnv, execContext as unknown as ExecutionContext);
    }

    return { app, cacheKv, callCount, fetch: fetchApp };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idempotencyMiddleware", () => {
    describe("pass-through (no idempotency key)", () => {
        it("calls the route handler when no Idempotency-Key header", async () => {
            const { callCount, fetch } = buildApp({});
            const context = createAwaitingContext();
            const res = await fetch({}, context);

            await context.flush();

            expect(res.status).toBe(200);
            expect(callCount.value).toBe(1);
        });

        it("does not set X-Idempotency-Replayed header", async () => {
            const { fetch } = buildApp({});
            const context = createAwaitingContext();
            const res = await fetch({}, context);

            await context.flush();

            expect(res.headers.get("X-Idempotency-Replayed")).toBeNull();
        });

        it("does not store response in KV", async () => {
            const { cacheKv, fetch } = buildApp({});
            const context = createAwaitingContext();

            await fetch({}, context);
            await context.flush();

            expect(cacheKv.size()).toBe(0);
        });
    });

    describe("first request (cache miss)", () => {
        it("calls the route handler on first use of a key", async () => {
            const { callCount, fetch } = buildApp({});
            const context = createAwaitingContext();
            const res = await fetch({ idempotencyKey: "first-key-001" }, context);

            await context.flush();

            expect(res.status).toBe(200);
            expect(callCount.value).toBe(1);
        });

        it("does not set X-Idempotency-Replayed on first request", async () => {
            const { fetch } = buildApp({});
            const context = createAwaitingContext();
            const res = await fetch({ idempotencyKey: "first-key-002" }, context);

            await context.flush();

            expect(res.headers.get("X-Idempotency-Replayed")).toBeNull();
        });

        it("stores the response in KV after first request", async () => {
            const { cacheKv, fetch } = buildApp({});
            const context = createAwaitingContext();

            await fetch({ idempotencyKey: "store-key-001" }, context);
            await context.flush();

            expect(cacheKv.size()).toBe(1);
        });
    });

    describe("deduplication (cache hit)", () => {
        it("does not call route handler on second request with same key", async () => {
            const { callCount, fetch } = buildApp({});

            const context1 = createAwaitingContext();

            await fetch({ idempotencyKey: "dedup-001" }, context1);
            await context1.flush();
            expect(callCount.value).toBe(1);

            const context2 = createAwaitingContext();
            const res2 = await fetch({ idempotencyKey: "dedup-001" }, context2);

            await context2.flush();

            expect(res2.status).toBe(200);
            expect(callCount.value).toBe(1); // Handler NOT called again
        });

        it("sets X-Idempotency-Replayed: true on replayed response", async () => {
            const { fetch } = buildApp({});

            const context1 = createAwaitingContext();

            await fetch({ idempotencyKey: "replay-001" }, context1);
            await context1.flush();

            const context2 = createAwaitingContext();
            const res2 = await fetch({ idempotencyKey: "replay-001" }, context2);

            expect(res2.headers.get("X-Idempotency-Replayed")).toBe("true");
        });

        it("replayed response body is identical to original", async () => {
            const { fetch } = buildApp({});

            const context1 = createAwaitingContext();
            const res1 = await fetch({ idempotencyKey: "body-001" }, context1);
            const body1 = await res1.json();

            await context1.flush();

            const context2 = createAwaitingContext();
            const res2 = await fetch({ idempotencyKey: "body-001" }, context2);
            const body2 = await res2.json();

            expect(body2).toEqual(body1);
        });
    });

    describe("user scoping", () => {
        it("different users with same key are independently cached", async () => {
            const cacheKv = new MockKVNamespace();

            const userA = buildApp({ cacheKv, userId: "user-A" });
            const userB = buildApp({ cacheKv, userId: "user-B" });

            // user-A makes a request with key "shared"
            const contextA = createAwaitingContext();

            await userA.fetch({ idempotencyKey: "shared" }, contextA);
            await contextA.flush();
            expect(userA.callCount.value).toBe(1);

            // user-B's request with same key should NOT be replayed
            const contextB = createAwaitingContext();
            const resB = await userB.fetch({ idempotencyKey: "shared" }, contextB);

            await contextB.flush();

            expect(resB.headers.get("X-Idempotency-Replayed")).toBeNull();
            expect(userB.callCount.value).toBe(1); // user-B handler was called
        });

        it("two different keys for the same user are independent", async () => {
            const { callCount, fetch } = buildApp({});

            const context1 = createAwaitingContext();

            await fetch({ idempotencyKey: "key-A" }, context1);
            await context1.flush();

            const context2 = createAwaitingContext();

            await fetch({ idempotencyKey: "key-B" }, context2);
            await context2.flush();

            // Both should have hit the handler
            expect(callCount.value).toBe(2);
        });
    });

    describe("streaming bypass", () => {
        it("does not cache streaming (text/event-stream) responses", async () => {
            const { cacheKv, fetch } = buildApp({});

            const context = createAwaitingContext();
            const res = await fetch({ idempotencyKey: "stream-key", isStreaming: true }, context);

            await context.flush();

            expect(res.headers.get("Content-Type")).toMatch(EVENT_STREAM_CONTENT_TYPE_RE);
            // Nothing should be in KV for streaming
            expect(cacheKv.size()).toBe(0);
        });

        it("streaming requests are not replayed from cache (no caching = no replay)", async () => {
            const { callCount, fetch } = buildApp({});

            // Two streaming requests with same key
            const context1 = createAwaitingContext();

            await fetch({ idempotencyKey: "stream-replay", isStreaming: true }, context1);
            await context1.flush();

            const context2 = createAwaitingContext();

            await fetch({ idempotencyKey: "stream-replay", isStreaming: true }, context2);
            await context2.flush();

            // Both should have called the handler (streaming is never cached/replayed)
            expect(callCount.value).toBe(2);
        });
    });

    describe("expiry simulation", () => {
        it("treats missing KV entry as a cache miss after simulated expiry", async () => {
            const { cacheKv, callCount, fetch } = buildApp({});

            const context1 = createAwaitingContext();

            await fetch({ idempotencyKey: "expire-key" }, context1);
            await context1.flush();
            expect(callCount.value).toBe(1);

            // Simulate key expiry by deleting from KV
            await cacheKv.delete("idempotency:user-123:expire-key");

            // Next request should be treated as a new request
            const context2 = createAwaitingContext();
            const res2 = await fetch({ idempotencyKey: "expire-key" }, context2);

            await context2.flush();

            expect(callCount.value).toBe(2);
            expect(res2.headers.get("X-Idempotency-Replayed")).toBeNull();
        });
    });
});

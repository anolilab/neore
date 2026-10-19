/**
 * POST /v1/responses, with the dispatcher replaced by a stub (or by a small
 * top-level app that mirrors `src/index.ts`). The real app wiring is covered by
 * `integration/responses.integration.test.ts`.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { AppEnv, HonoEnv } from "../env.js";
import { logger } from "../lib/logger.js";
import loggerMiddleware from "../middleware/logger.js";
import { securityMiddleware } from "../middleware/security.js";
import { telemetryMiddleware } from "../middleware/telemetry.js";
import type { Dispatch } from "../routes/v1/responses.js";
import { createResponsesRouter } from "../routes/v1/responses.js";

interface Recorded {
    body: Record<string, unknown>;
    headers: Record<string, string>;
    path: string;
}

const ctx = { passThroughOnException() {}, waitUntil() {} } as unknown as ExecutionContext;
const env = {} as unknown as AppEnv;
const FUNCTION_CALL_ID = /^fc_/;

const CHAT_REPLY = {
    choices: [{ finish_reason: "stop", message: { content: "pong" } }],
    created: 1,
    id: "chatcmpl-1",
    model: "gpt-x",
    object: "chat.completion",
    usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
};

/** Builds a dispatcher that records what it receives and answers with `reply`. */
const stubDispatch = (reply: () => Response) => {
    const calls: Recorded[] = [];
    const dispatch: Dispatch = async (request) => {
        calls.push({
            body: (await request.json()) as Record<string, unknown>,
            headers: Object.fromEntries(request.headers.entries()),
            path: new URL(request.url).pathname,
        });

        return reply();
    };

    return { calls, dispatch };
};

const jsonReply =
    (body: unknown, status = 200) =>
    () =>
        Response.json(body, { headers: { "Content-Type": "application/json" }, status });

/** A keyed caller by default: the route refuses a request with no Authorization header before it parses. */
const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://gateway.test/v1/responses", {
        body: JSON.stringify(body),
        headers: { authorization: "Bearer gk_test_key", "Content-Type": "application/json", ...headers },
        method: "POST",
    });

const appWith = (dispatch: Dispatch) => {
    const app = new Hono<HonoEnv>();

    app.route("/", createResponsesRouter(dispatch));

    return app;
};

describe("POST /v1/responses — forwarding", () => {
    it("forwards Authorization, Idempotency-Key and Origin to the dispatched request and translates the reply", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));
        const response = await appWith(dispatch).fetch(
            post(
                { input: "ping", instructions: "Terse.", model: "gpt-x" },
                { authorization: "Bearer gk_test_key", "idempotency-key": "idem-1", origin: "https://app.example" },
            ),
            env,
            ctx,
        );

        expect(response.status).toBe(200);
        expect(calls).toHaveLength(1);

        const [call] = calls;

        expect(call.path).toBe("/v1/chat/completions");
        expect(call.headers.authorization).toBe("Bearer gk_test_key");
        // Namespaced, so it cannot replay a reply cached by /v1/chat/completions under the same key.
        expect(call.headers["idempotency-key"]).toBe("responses:idem-1");
        expect(call.headers.origin).toBe("https://app.example");
        expect(call.body).toEqual({
            messages: [
                { content: "Terse.", role: "system" },
                { content: "ping", role: "user" },
            ],
            model: "gpt-x",
            stream: false,
        });

        const body = (await response.json()) as { object: string; output: { content: { text: string }[] }[]; status: string };

        expect(body.object).toBe("response");
        expect(body.status).toBe("completed");
        expect(body.output[0].content[0].text).toBe("pong");
    });

    it("refuses a request with no Authorization header with a 401 before parsing or dispatching", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));
        const unauthenticated = new Request("https://gateway.test/v1/responses", {
            body: "not json",
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const response = await appWith(dispatch).fetch(unauthenticated, env, ctx);

        expect(response.status).toBe(401);
        expect(calls).toHaveLength(0);
        expect(((await response.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");
    });

    it.each([["Bearer not_a_gateway_key"], ["Basic abc"], ["gk_without_scheme"]])(
        "refuses %j, which cannot be a gateway key, before parsing or dispatching",
        async (authorization) => {
            const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));
            const request = new Request("https://gateway.test/v1/responses", {
                body: "not json",
                headers: { Authorization: authorization, "Content-Type": "application/json" },
                method: "POST",
            });
            const response = await appWith(dispatch).fetch(request, env, ctx);

            expect(response.status).toBe(401);
            expect(calls).toHaveLength(0);
        },
    );

    it("sends no Idempotency-Key when the caller sent none", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));

        await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x" }), env, ctx);

        expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
    });

    it("refuses previous_response_id with a 400 and never dispatches", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));
        const response = await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", previous_response_id: "resp_1" }), env, ctx);

        expect(response.status).toBe(400);
        expect(calls).toHaveLength(0);
        expect(((await response.json()) as { error: { param: string } }).error.param).toBe("previous_response_id");
    });

    it("passes tool_choice through to the dispatched body in the chat shape", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));

        await appWith(dispatch).fetch(
            post({ input: "x", model: "gpt-x", tool_choice: { name: "get_weather", type: "function" }, tools: [{ name: "get_weather", type: "function" }] }),
            env,
            ctx,
        );

        expect(calls[0].body.tool_choice).toEqual({ function: { name: "get_weather" }, type: "function" });
    });

    it("does not forward user: the dispatched body has no user field", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));

        await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", user: "u1" }), env, ctx);

        expect(calls[0].body).not.toHaveProperty("user");
    });
});

describe("POST /v1/responses — non-streaming with tools", () => {
    const TOOL_REPLY = {
        choices: [
            {
                finish_reason: "tool_calls",
                message: {
                    content: null,
                    role: "assistant",
                    tool_calls: [{ function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: "call_1", type: "function" }],
                },
            },
        ],
        created: 1,
        id: "chatcmpl-2",
        model: "gpt-x",
        object: "chat.completion",
        usage: { completion_tokens: 4, prompt_tokens: 9, total_tokens: 13 },
    };

    it("dispatches as non-streaming and returns the tool call the chat reply carries as a function_call item", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(TOOL_REPLY));
        const response = await appWith(dispatch).fetch(
            post({ input: "weather?", model: "gpt-x", tools: [{ name: "get_weather", parameters: { type: "object" }, type: "function" }] }),
            env,
            ctx,
        );

        expect(calls[0].body.stream).toBe(false);
        expect(response.status).toBe(200);

        const body = (await response.json()) as { output: unknown[]; status: string; usage: unknown };

        expect(body.status).toBe("completed");
        expect(body.usage).toEqual({ input_tokens: 9, output_tokens: 4, total_tokens: 13 });
        expect(body.output).toEqual([
            {
                arguments: '{"city":"Oslo"}',
                call_id: "call_1",
                id: expect.stringMatching(FUNCTION_CALL_ID),
                name: "get_weather",
                status: "completed",
                type: "function_call",
            },
        ]);
    });

    it("answers with the upstream's message and status when the chat request failed", async () => {
        const { dispatch } = stubDispatch(jsonReply({ error: { message: "provider down", type: "server_error" } }, 502));
        const response = await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", tools: [{ name: "f", type: "function" }] }), env, ctx);

        expect(response.status).toBe(502);
        expect(((await response.json()) as { error: { message: string } }).error.message).toBe("provider down");
    });
});

describe("POST /v1/responses — streaming", () => {
    const sseReply = () =>
        new Response(
            'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null,"index":0}]}\n\n' +
                'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n' +
                "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
        );

    it("translates an event-stream reply for a stream request", async () => {
        const { calls, dispatch } = stubDispatch(sseReply);
        const response = await appWith(dispatch).fetch(post({ input: "ping", model: "gpt-x", stream: true }), env, ctx);
        const text = await response.text();

        expect(calls[0].body.stream).toBe(true);
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
        expect(text).toContain("event: response.output_text.delta");
        expect(text).toContain("event: response.completed");
    });

    it("answers a stream request with a cached JSON reply as JSON, not as an empty stream", async () => {
        const { dispatch } = stubDispatch(jsonReply(CHAT_REPLY));
        const response = await appWith(dispatch).fetch(post({ input: "ping", model: "gpt-x", stream: true }), env, ctx);

        expect(response.headers.get("Content-Type")).toContain("application/json");

        const body = (await response.json()) as { object: string; output: { content: { text: string }[] }[]; status: string };

        expect(body.object).toBe("response");
        expect(body.status).toBe("completed");
        expect(body.output[0].content[0].text).toBe("pong");
    });
});

describe("POST /v1/responses — dispatch through the top-level app", () => {
    it("records the call once, on the outer request, and runs the route middleware once for the inner one", async () => {
        const seen = { inner: [] as { requestId: string; rootSpan: unknown; telemetry: unknown }[], rateLimitHits: 0 };
        const outer = {} as { requestId?: string; rootSpan?: unknown; telemetry?: unknown };
        const topLevel = new Hono<HonoEnv>();
        const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
        const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

        // The real app-level middleware, in the order `src/index.ts` mounts them.
        topLevel.use("*", securityMiddleware);
        topLevel.use("*", telemetryMiddleware);
        topLevel.use("*", loggerMiddleware);
        // Records what the outer request holds, just before the responses route dispatches.
        topLevel.use("/v1/responses", async (c, next) => {
            outer.requestId = c.get("requestId");
            outer.rootSpan = c.get("rootSpan");
            outer.telemetry = c.get("telemetry");

            await next();
        });
        // Stands in for the completions route's rateLimitMiddleware, which is mounted on that path only.
        topLevel.use("/v1/chat/completions", async (_c, next) => {
            seen.rateLimitHits += 1;

            await next();
        });
        topLevel.post("/v1/chat/completions", (c) => {
            seen.inner.push({ requestId: c.get("requestId"), rootSpan: c.get("rootSpan"), telemetry: c.get("telemetry") });

            return c.json(CHAT_REPLY);
        });
        topLevel.route(
            "/",
            createResponsesRouter((request, dispatchEnv, dispatchCtx) => topLevel.fetch(request, dispatchEnv, dispatchCtx)),
        );

        try {
            const response = await topLevel.fetch(post({ input: "x", model: "gpt-x" }), env, ctx);

            expect(response.status).toBe(200);
            expect(response.headers.get("X-Request-Id")).toBe(outer.requestId);

            expect(seen.rateLimitHits).toBe(1);
            expect(seen.inner).toHaveLength(1);
            expect(seen.inner[0].requestId).toBe(outer.requestId);
            expect(seen.inner[0].rootSpan).toBe(outer.rootSpan);
            expect(seen.inner[0].telemetry).toBe(outer.telemetry);

            // One line for the call, from the outer request's logger middleware.
            expect(info.mock.calls.length + warn.mock.calls.length + error.mock.calls.length).toBe(1);
            expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: "/v1/responses", requestId: outer.requestId, status: 200 }));
        } finally {
            info.mockRestore();
            warn.mockRestore();
            error.mockRestore();
        }
    });
});

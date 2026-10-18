/**
 * POST /v1/responses, with the dispatcher replaced by a stub (or by a small
 * top-level app that mirrors `src/index.ts`). The real app wiring is covered by
 * `integration/responses.integration.test.ts`.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AppEnv, HonoEnv } from "../env.js";
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

const sse = (...frames: unknown[]): string => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

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
const sseReply = (text: string) => () => new Response(text, { headers: { "Content-Type": "text/event-stream" }, status: 200 });

const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://gateway.test/v1/responses", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...headers },
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
        expect(call.headers["idempotency-key"]).toBe("idem-1");
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

    it("refuses previous_response_id with a 400 and never dispatches", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));
        const response = await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", previous_response_id: "resp_1" }), env, ctx);

        expect(response.status).toBe(400);
        expect(calls).toHaveLength(0);
        expect(((await response.json()) as { error: { param: string } }).error.param).toBe("previous_response_id");
    });

    it('refuses a tool_choice other than "auto" with a 400 that names it, and never dispatches', async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));
        const response = await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", tool_choice: "required" }), env, ctx);

        expect(response.status).toBe(400);
        expect(calls).toHaveLength(0);
        expect(((await response.json()) as { error: { param: string } }).error.param).toBe("tool_choice");
    });

    it("does not forward user: the dispatched body has no user field", async () => {
        const { calls, dispatch } = stubDispatch(jsonReply(CHAT_REPLY));

        await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", user: "u1" }), env, ctx);

        expect(calls[0].body).not.toHaveProperty("user");
    });
});

describe("POST /v1/responses — non-streaming with tools", () => {
    it("dispatches as a stream and folds the reply into a function_call item", async () => {
        const text = sse(
            {
                choices: [
                    {
                        delta: { tool_calls: [{ function: { arguments: '{"city":"Oslo"}', name: "get_weather" }, id: "call_1", index: 0, type: "function" }] },
                        finish_reason: null,
                        index: 0,
                    },
                ],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
        );
        const { calls, dispatch } = stubDispatch(sseReply(text));
        const response = await appWith(dispatch).fetch(
            post({ input: "weather?", model: "gpt-x", tools: [{ name: "get_weather", parameters: { type: "object" }, type: "function" }] }),
            env,
            ctx,
        );

        expect(calls[0].body.stream).toBe(true);
        expect(response.status).toBe(200);

        const body = (await response.json()) as { object: string; output: unknown[]; status: string };

        expect(body.object).toBe("response");
        expect(body.status).toBe("completed");
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

    it("masks PII in the folded text, as completions does for its non-streaming reply", async () => {
        const text = sse(
            { choices: [{ delta: { content: "Mail jane@example.com please" }, finish_reason: null, index: 0 }] },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        );
        const { dispatch } = stubDispatch(sseReply(text));
        const response = await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", tools: [{ name: "f", type: "function" }] }), env, ctx);
        const serialised = JSON.stringify(await response.json());

        expect(serialised).not.toContain("jane@example.com");
    });

    it("answers 502 with the provider's message when the folded stream failed", async () => {
        const text = sse({ error: { message: "provider down" } }, { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
        const { dispatch } = stubDispatch(sseReply(text));
        const response = await appWith(dispatch).fetch(post({ input: "x", model: "gpt-x", tools: [{ name: "f", type: "function" }] }), env, ctx);

        expect(response.status).toBe(502);
        expect(((await response.json()) as { error: { message: string } }).error.message).toBe("provider down");
    });
});

describe("POST /v1/responses — dispatch through the top-level app", () => {
    it("runs the app-level middleware for the inner request, and the route middleware once", async () => {
        const seen = { inner: [] as string[], rateLimitHits: 0 };
        const topLevel = new Hono<HonoEnv>();
        let runs = 0;

        // Stands in for securityMiddleware: sets a per-request var each time it runs.
        topLevel.use("*", async (c, next) => {
            runs += 1;
            c.set("requestId", `req-${runs}`);
            await next();
        });
        // Stands in for the completions route's rateLimitMiddleware, which is mounted on that path only.
        topLevel.use("/v1/chat/completions", async (_c, next) => {
            seen.rateLimitHits += 1;
            await next();
        });
        topLevel.post("/v1/chat/completions", (c) => {
            seen.inner.push(c.get("requestId") ?? "");

            return c.json(CHAT_REPLY);
        });
        topLevel.route(
            "/",
            createResponsesRouter((request, dispatchEnv, dispatchCtx) => topLevel.fetch(request, dispatchEnv, dispatchCtx)),
        );

        const response = await topLevel.fetch(post({ input: "x", model: "gpt-x" }), env, ctx);

        expect(response.status).toBe(200);
        expect(runs).toBe(2);
        expect(seen.inner).toEqual(["req-2"]);
        expect(seen.rateLimitHits).toBe(1);
    });
});

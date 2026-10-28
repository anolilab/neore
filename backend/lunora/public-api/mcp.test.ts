/**
 * The MCP endpoint through the real router: framing, the tool list, and that a
 * tool call is the route behind it — scopes, per-key limit and locked-thread
 * handling included — with a fake ctx standing in for the runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import type { LunoraHttpEnv } from "lunorash/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import z from "zod/v4";

import { runChatStart } from "../chat/http";
import { THREAD_LOCKED_CODE } from "../lib/thread-lock";
import { buildMcpTools } from "./mcp";
import type { RouteDefinition } from "./routes";
import { ROUTES } from "./routes";
import { createPublicApiRouter } from "./router";
import type { ApiScopes } from "./scopes";

vi.mock("../chat/http", () => {
    return { runChatStart: vi.fn() };
});

// The shard hop is the runtime's; the handler only needs the ctx it was given.
vi.mock("../lib/http-shard", () => {
    return {
        inShard: async (ctx: unknown, _shardKey: string, handler: (ctx: unknown) => Promise<unknown>) => await handler(ctx),
        shardContext: (ctx: unknown) => ctx,
    };
});

const TOOL_NAME = /^[\w.-]{1,128}$/u;

const jsonOf = async (pending: Promise<Response>): Promise<unknown> => {
    const response = await pending;

    return await response.json();
};

const statusOf = async (pending: Promise<Response>): Promise<number> => {
    const response = await pending;

    return response.status;
};

const READ_SCOPES: ApiScopes = { knowledge: ["read"], tasks: ["read"], threads: ["read"] };

const openThread = { _creationTime: 1, _id: "t1", status: "active", title: "Plan", userId: "user1" };

interface Fixture {
    /** What `getChunksAfter` answers on every read. Default: a finished stream with one chunk. */
    chunks?: { chunks: { text: string }[]; locked?: boolean; pendingRequest?: object; status: string };
    identity?: object | null;
    limit?: { ok: boolean; retryAfter?: number };
    routes?: ReadonlyArray<RouteDefinition>;
    scopes?: ApiScopes;
    thread?: Record<string, unknown>;
    threadsFail?: unknown;
}

const setup = (fixture: Fixture = {}) => {
    const calls: { args: unknown; name: string }[] = [];
    // The idempotency store and the claim table, as the runtime keeps them.
    const stored = new Map<string, unknown>();
    const claims = new Map<string, number>();
    const run = async (ref: { __lunoraRef: string }, args: unknown) => {
        const name = ref.__lunoraRef;

        calls.push({ args, name });

        switch (name) {
            case "chat_functions:getThread": {
                return fixture.thread ?? openThread;
            }
            case "chat_functions:getThreads": {
                return { continueCursor: "", isDone: true, page: [openThread] };
            }
            case "chat_functions:getThreadUIMessages": {
                if (fixture.threadsFail) {
                    throw fixture.threadsFail;
                }

                return { continueCursor: "", isDone: true, page: [] };
            }
            case "chat_streaming_persistent_library:getChunksAfter": {
                return { locked: false, totalChunks: 0, ...(fixture.chunks ?? { chunks: [{ text: "Hello" }], status: "done" }) };
            }
            case "lib_action_cache:get": {
                const { key } = args as { key: string };

                return stored.has(key) ? { kind: "hit", value: stored.get(key) } : { kind: "miss" };
            }
            case "lib_action_cache:put": {
                stored.set((args as { key: string }).key, (args as { value: unknown }).value);

                return null;
            }
            case "lib_action_cache:remove": {
                stored.delete((args as { key: string }).key);

                return null;
            }
            case "lib_claim_once:claimKeyFenced": {
                const { key } = args as { key: string };

                if (claims.has(key)) {
                    return null;
                }

                claims.set(key, 1);

                return 1;
            }
            case "lib_claim_once:releaseKey": {
                claims.delete((args as { key: string }).key);

                return null;
            }
            case "lib_rate_limiter_mutations:applyRateLimit": {
                return fixture.limit ?? { ok: true };
            }
            default: {
                return null;
            }
        }
    };
    const identity =
        fixture.identity === undefined ? { apiKeyId: "key1", apiKeyScopes: fixture.scopes ?? READ_SCOPES, authMethod: "api_key" } : fixture.identity;
    const ctx = { auth: { getIdentity: async () => identity, userId: identity ? "user1" : undefined }, runMutation: run, runQuery: run };
    const app = new Hono<LunoraHttpEnv>();

    app.use("*", async (c, next) => {
        (c as unknown as { set: (key: string, value: unknown) => void }).set("lunora", ctx);
        await next();
    });
    app.route("/api/v1", createPublicApiRouter(fixture.routes));

    return {
        calls,
        claims,
        fetch: async (input: URL | string, init?: RequestInit) => await app.request(input, init),
        post: async (body: unknown, headers: Record<string, string> = {}) =>
            await app.request("https://api.example/api/v1/mcp", {
                body: typeof body === "string" ? body : JSON.stringify(body),
                headers: { "Content-Type": "application/json", ...headers },
                method: "POST",
            }),
        request: async (path: string, init?: RequestInit) => await app.request(`https://api.example/api/v1${path}`, init),
    };
};

interface ToolResult {
    content: { text: string; type: string }[];
    isError: boolean;
    resultType?: string;
    structuredContent?: Record<string, any>;
}

const rpc = (method: string, params?: Record<string, unknown>, id: number | string = 1) => {
    return { id, jsonrpc: "2.0", method, ...(params && { params }) };
};

const callTool = async (fixture: Fixture, name: string, args: Record<string, unknown> = {}) => {
    const harness = setup(fixture);
    const response = await harness.post(rpc("tools/call", { arguments: args, name }));

    return { ...harness, response, result: ((await response.json()) as { result?: ToolResult }).result };
};

const rateLimitCalls = (calls: { args: unknown; name: string }[]) => calls.filter((entry) => entry.name === "lib_rate_limiter_mutations:applyRateLimit");

describe("MCP framing", () => {
    it("answers a legacy initialize with a version it supports, and no session", async () => {
        const { post } = setup();
        const response = await post(rpc("initialize", { capabilities: {}, clientInfo: { name: "c", version: "1" }, protocolVersion: "2025-06-18" }));
        const body = (await response.json()) as { result: Record<string, any> };

        expect(response.status).toBe(200);
        expect(response.headers.get("Mcp-Session-Id")).toBeNull();
        expect(body.result["protocolVersion"]).toBe("2025-06-18");
        expect(body.result["capabilities"]).toEqual({ tools: { listChanged: false } });
        expect(body.result).not.toHaveProperty("resultType");
    });

    it("offers its newest legacy version to a client asking for one it does not know", async () => {
        const { post } = setup();
        const body = (await jsonOf(post(rpc("initialize", { protocolVersion: "1999-01-01" })))) as { result: { protocolVersion: string } };

        expect(body.result.protocolVersion).toBe("2025-11-25");
    });

    it("accepts a notification with 202 and no body", async () => {
        const { post } = setup();
        const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });

        expect(response.status).toBe(202);
        expect(await response.text()).toBe("");
    });

    it("answers ping, and an unknown method as method-not-found", async () => {
        const { post } = setup();

        expect(await jsonOf(post(rpc("ping")))).toEqual({ id: 1, jsonrpc: "2.0", result: {} });
        expect(await jsonOf(post(rpc("resources/list")))).toMatchObject({ error: { code: -32_601 }, id: 1 });
    });

    it("draws on the key's read limit for protocol calls, and answers 429 when it is spent", async () => {
        const ok = setup();

        await ok.post(rpc("ping"));
        await ok.post(rpc("tools/list"));

        expect(rateLimitCalls(ok.calls)).toHaveLength(2);

        const spent = setup({ limit: { ok: false, retryAfter: 2000 } });
        const response = await spent.post(rpc("ping"));

        expect(response.status).toBe(429);
    });

    it("refuses bad JSON, a batch and a non-JSON-RPC body with 400", async () => {
        const { post } = setup();

        expect(await statusOf(post("{nope"))).toBe(400);
        expect(await jsonOf(post([rpc("ping")]))).toMatchObject({ error: { code: -32_600 } });
        expect(await statusOf(post({ hello: "world" }))).toBe(400);
    });

    it("answers 401 without a key and 405 to GET and DELETE", async () => {
        const anonymous = setup({ identity: null });

        expect(await statusOf(anonymous.post(rpc("ping")))).toBe(401);

        const { request } = setup();
        const get = await request("/mcp");

        expect(get.status).toBe(405);
        expect(get.headers.get("Allow")).toBe("POST");
        expect(await statusOf(request("/mcp", { method: "DELETE" }))).toBe(405);
    });
});

describe("MCP modern protocol", () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    const headers = (method: string, extra: Record<string, string> = {}) => {
        return { "Mcp-Method": method, "MCP-Protocol-Version": "2026-07-28", ...extra };
    };

    it("answers server/discover statelessly", async () => {
        const { post } = setup();
        const response = await post(rpc("server/discover", { _meta: meta }), headers("server/discover"));
        const body = (await response.json()) as { result: Record<string, any> };

        expect(response.status).toBe(200);
        expect(body.result).toMatchObject({
            capabilities: { tools: {} },
            resultType: "complete",
            supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]),
        });
    });

    it("lists tools and runs a call with the modern result fields", async () => {
        const { post } = setup();
        const list = (await jsonOf(post(rpc("tools/list", { _meta: meta }), headers("tools/list")))) as { result: Record<string, any> };

        expect(list.result).toMatchObject({ cacheScope: "private", resultType: "complete", ttlMs: 0 });

        const called = await post(
            rpc("tools/call", { _meta: meta, arguments: { threadId: "t1" }, name: "get_thread" }),
            headers("tools/call", { "Mcp-Name": "get_thread" }),
        );

        expect(((await called.json()) as { result: ToolResult }).result).toMatchObject({ isError: false, resultType: "complete" });
    });

    it("refuses a modern initialize, and a modern header over a body without the version", async () => {
        const { post } = setup();
        const initialize = await post(rpc("initialize", { _meta: meta, protocolVersion: "2026-07-28" }), headers("initialize"));

        expect(initialize.status).toBe(404);
        expect(await initialize.json()).toMatchObject({ error: { code: -32_601 } });

        const missing = await post(rpc("tools/list"), headers("tools/list"));

        expect(missing.status).toBe(400);
        expect(await missing.json()).toMatchObject({ error: { code: -32_020 } });
    });

    it("rejects a header that disagrees with the body, and a version it does not serve", async () => {
        const { post } = setup();
        const mismatch = await post(rpc("tools/list", { _meta: meta }), headers("tools/call"));

        expect(mismatch.status).toBe(400);
        expect(await mismatch.json()).toMatchObject({ error: { code: -32_020 } });

        const unsupported = await post(rpc("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } }), {
            "Mcp-Method": "tools/list",
            "MCP-Protocol-Version": "1900-01-01",
        });

        expect(unsupported.status).toBe(400);
        expect(await unsupported.json()).toMatchObject({ error: { code: -32_022, data: { requested: "1900-01-01" } } });
    });
});

describe("MCP tools/list", () => {
    const names = async (fixture: Fixture) => {
        const { post } = setup(fixture);
        const body = (await jsonOf(post(rpc("tools/list")))) as { result: { tools: { name: string }[] } };

        return body.result.tools.map((tool) => tool.name);
    };

    it("lists the read tools for a read-scoped key, and no write tool", async () => {
        const listed = await names({});

        expect(listed).toEqual(["list_threads", "get_thread", "read_messages", "list_tasks", "get_task", "search_knowledge"]);
    });

    it("lists only the tools whose scopes the key holds", async () => {
        expect(await names({ scopes: { knowledge: ["read"] } })).toEqual(["search_knowledge"]);
        expect(await names({ scopes: { threads: ["write"] } })).toEqual([]);
    });

    it("hides a write tool from a read key but still refuses a forced call to it", async () => {
        const handler = vi.fn(async () => {
            return { data: { sent: true } };
        });
        const sendMessage: RouteDefinition = {
            body: z.object({ prompt: z.string() }),
            handler,
            mcp: [{ description: "Send a message.", tool: "fixture_send" }],
            method: "post",
            operationId: "fixtureSend",
            path: "/fixture/send",
            response: z.object({ sent: z.boolean() }),
            scopes: [["chat", "write"]],
            summary: "Send",
            tag: "Chat",
        };
        const fixture = { routes: [...ROUTES, sendMessage] };

        expect(await names(fixture)).not.toContain("fixture_send");

        const { calls, result } = await callTool(fixture, "fixture_send", {});

        expect(result?.isError).toBe(true);
        expect(result?.structuredContent).toMatchObject({ error: { code: "insufficient_scope", details: { required: ["chat:write"] } } });
        expect(handler).not.toHaveBeenCalled();
        expect(rateLimitCalls(calls)).toEqual([]);
    });
});

describe("MCP tools/call", () => {
    it("reads a thread as structured data", async () => {
        const { response, result } = await callTool({}, "get_thread", { threadId: "t1" });

        expect(response.status).toBe(200);
        expect(result).toMatchObject({ isError: false, structuredContent: { id: "t1", title: "Plan" } });
        expect(JSON.parse(result!.content[0]!.text)).toEqual(result!.structuredContent);
    });

    it("lists threads, with a numeric limit taken as the string the route reads", async () => {
        const { result } = await callTool({}, "list_threads", { limit: 5 });

        expect(result?.isError).toBe(false);
        expect(result?.structuredContent?.["data"]).toEqual([expect.objectContaining({ id: "t1" })]);
    });

    it("consumes the same publicApi/read limit as REST", async () => {
        const mcp = await callTool({}, "get_thread", { threadId: "t1" });
        const rest = setup();

        await rest.request("/threads/t1");

        const expected = [{ args: { identifier: "key1", key: "publicApi/read:free" }, name: "lib_rate_limiter_mutations:applyRateLimit" }];

        expect(rateLimitCalls(mcp.calls)).toEqual(expected);
        expect(rateLimitCalls(rest.calls)).toEqual(expected);
    });

    it("charges the key for a call the route never sees: an unknown tool and arguments it refuses", async () => {
        const unknown = await callTool({}, "no_such_tool", {});
        const badArguments = await callTool({}, "get_thread", { nope: "x", threadId: "t1" });

        expect(rateLimitCalls(unknown.calls)).toHaveLength(1);
        expect(badArguments.result?.isError).toBe(true);
        expect(rateLimitCalls(badArguments.calls)).toHaveLength(1);
    });

    it("answers rate_limited, and runs nothing, when the key's limit is spent", async () => {
        const { calls, result } = await callTool({ limit: { ok: false, retryAfter: 2000 } }, "get_thread", { threadId: "t1" });

        expect(result?.isError).toBe(true);
        expect(result?.structuredContent).toMatchObject({ error: { code: "rate_limited" } });
        expect(calls.map((entry) => entry.name)).toEqual(["lib_rate_limiter_mutations:applyRateLimit"]);
    });

    it("does not find a locked thread through get_thread", async () => {
        const { result } = await callTool({ thread: { ...openThread, lockedAt: 5, title: "Secret plan" } }, "get_thread", { threadId: "t1" });

        expect(result?.isError).toBe(true);
        expect(result?.structuredContent).toMatchObject({ error: { code: "not_found" } });
        expect(JSON.stringify(result)).not.toContain("Secret plan");
    });

    it("does not find a locked thread through read_messages", async () => {
        const locked = Object.assign(new Error("This chat is locked."), { data: { code: THREAD_LOCKED_CODE } });
        const { result } = await callTool({ threadsFail: locked }, "read_messages", { threadId: "t1" });

        expect(result?.isError).toBe(true);
        expect(result?.structuredContent).toMatchObject({ error: { code: "not_found" } });
    });

    it("refuses an unknown tool, a missing path argument and an unknown argument", async () => {
        const unknown = setup();
        const body = await jsonOf(unknown.post(rpc("tools/call", { name: "delete_everything" })));

        expect(body).toMatchObject({ error: { code: -32_602, message: "Unknown tool: delete_everything" } });

        const missing = await callTool({}, "get_thread", {});

        expect(missing.result?.structuredContent).toMatchObject({ error: { code: "invalid_request", message: "`threadId` is required." } });

        const extra = await callTool({}, "get_thread", { nope: "x", threadId: "t1" });

        expect(extra.result?.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
        expect(extra.calls.map((entry) => entry.name)).not.toContain("chat_functions:getThread");
    });
});

describe("MCP write tools", () => {
    const WRITE_SCOPES: ApiScopes = { chat: ["write"] };
    const started = { messageId: "m1", streamId: "s1", streamToken: "tok", threadId: "t1" };
    const startedResponse = () => Response.json(started);
    const chatStart = vi.mocked(runChatStart);

    beforeEach(() => {
        chatStart.mockReset();
        chatStart.mockImplementation(async () => startedResponse());
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "secret");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    const send = async (fixture: Fixture, args: Record<string, unknown>, tool = "send_message") =>
        await callTool({ scopes: WRITE_SCOPES, ...fixture }, tool, args);

    it("lists both write tools for a chat:write key, with the right arguments", async () => {
        const { post } = setup({ scopes: WRITE_SCOPES });
        const body = (await jsonOf(post(rpc("tools/list")))) as { result: { tools: { inputSchema: any; name: string }[] } };
        const byName = Object.fromEntries(body.result.tools.map((tool) => [tool.name, tool.inputSchema]));

        expect(Object.keys(byName)).toEqual(["create_thread", "send_message"]);
        expect(byName["create_thread"].required).toEqual(["prompt"]);
        expect(Object.keys(byName["create_thread"].properties)).toEqual(["model", "prompt", "idempotencyKey"]);
        expect(byName["send_message"].required).toEqual(["prompt", "threadId"]);
        expect(Object.keys(byName["send_message"].properties)).toEqual(["model", "prompt", "threadId", "idempotencyKey"]);
        expect(byName["send_message"].additionalProperties).toBe(false);
    });

    it("sends with chat:write alone, but cannot list threads", async () => {
        const sent = await send({}, { prompt: "hello", threadId: "t1" });

        expect(sent.result).toMatchObject({
            isError: false,
            structuredContent: { messageId: "m1", status: "done", text: "Hello", threadId: "t1" },
        });

        const listed = await send({}, {}, "list_threads");

        expect(listed.result?.isError).toBe(true);
        expect(listed.result?.structuredContent).toMatchObject({ error: { code: "insufficient_scope", details: { required: ["threads:read"] } } });
    });

    it("runs the chat as a blocking turn on the write limit, like POST /chat", async () => {
        const { calls } = await send({}, { prompt: "hello", threadId: "t1" });

        expect(chatStart).toHaveBeenCalledOnce();
        // The run is capped at ask-mode tools with no device tools (`origin`).
        expect(chatStart.mock.calls[0]?.[1]).toMatchObject({ mode: "text", origin: "api-key", prompt: "hello", threadId: "t1" });
        expect(rateLimitCalls(calls)).toEqual([
            { args: { identifier: "key1", key: "publicApi/write:free" }, name: "lib_rate_limiter_mutations:applyRateLimit" },
        ]);
    });

    it("starts a thread without a threadId, and refuses one", async () => {
        const created = await send({}, { prompt: "hello" }, "create_thread");

        expect(created.result).toMatchObject({ isError: false, structuredContent: { threadId: "t1" } });
        expect(chatStart.mock.calls[0]?.[1]).not.toHaveProperty("threadId");

        const refused = await send({}, { prompt: "hello", threadId: "t1" }, "create_thread");

        expect(refused.result?.structuredContent).toMatchObject({ error: { code: "invalid_request", message: "`create_thread` has no argument `threadId`." } });
        expect(chatStart).toHaveBeenCalledOnce();
    });

    it("needs a threadId and a prompt for send_message, and never lets the model ask for a stream", async () => {
        const noThread = await send({}, { prompt: "hello" });
        const noPrompt = await send({}, { threadId: "t1" });
        const stream = await send({}, { prompt: "hello", stream: true, threadId: "t1" });

        expect(noThread.result?.structuredContent).toMatchObject({ error: { code: "invalid_request", message: "`threadId` is required." } });
        expect(noPrompt.result?.structuredContent).toMatchObject({ error: { code: "invalid_request", message: "`prompt` is required." } });
        expect(stream.result?.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
        expect(chatStart).not.toHaveBeenCalled();
    });

    it("creates one message for the same idempotencyKey twice, and replays the first result", async () => {
        const harness = setup({ scopes: WRITE_SCOPES });
        const call = async (args: Record<string, unknown>) => {
            const response = await harness.post(rpc("tools/call", { arguments: args, name: "send_message" }));

            return ((await response.json()) as { result: ToolResult }).result;
        };
        const args = { idempotencyKey: "once-1", prompt: "hello", threadId: "t1" };
        const first = await call(args);
        const second = await call(args);

        expect(chatStart).toHaveBeenCalledOnce();
        expect(second.structuredContent).toEqual(first.structuredContent);

        const different = await call({ ...args, prompt: "something else" });

        expect(different.structuredContent).toMatchObject({ error: { code: "idempotency_conflict" } });
        expect(chatStart).toHaveBeenCalledOnce();
    });

    it("treats the same key on another API key as a different request", async () => {
        const one = setup({ scopes: WRITE_SCOPES });
        const two = setup({ identity: { apiKeyId: "key2", apiKeyScopes: WRITE_SCOPES, authMethod: "api_key" } });
        const args = { idempotencyKey: "shared", prompt: "hello", threadId: "t1" };

        for (const harness of [one, two]) {
            await harness.post(rpc("tools/call", { arguments: args, name: "send_message" }));
        }

        expect(chatStart).toHaveBeenCalledTimes(2);
    });

    it("creates one message when two calls with one key arrive at once", async () => {
        let finish!: () => void;
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
        const gate = new Promise<void>((resolve) => {
            finish = resolve;
        });

        chatStart.mockImplementation(async () => {
            await gate;

            return startedResponse();
        });

        const harness = setup({ scopes: WRITE_SCOPES });
        const args = { idempotencyKey: "race", prompt: "hello", threadId: "t1" };
        const call = async (id: number) => {
            const response = await harness.post(rpc("tools/call", { arguments: args, name: "send_message" }, id));

            return ((await response.json()) as { result: ToolResult }).result;
        };
        const winner = call(1);

        await vi.waitFor(() => {
            expect(chatStart).toHaveBeenCalledOnce();
        });

        // The first is still running: the second finds the key held, not the stored result.
        const loser = await call(2);

        expect(loser.structuredContent).toMatchObject({ error: { code: "idempotency_in_progress" } });

        finish();

        const won = await winner;

        expect(won.isError).toBe(false);
        expect(chatStart).toHaveBeenCalledOnce();

        // The loser retries and reads the winner's stored result.
        const retried = await call(3);

        expect(retried.structuredContent).toMatchObject({ messageId: "m1" });
        expect(chatStart).toHaveBeenCalledOnce();
    });

    it("gives the key back when the send fails, so the retry runs", async () => {
        chatStart.mockImplementationOnce(async () => Response.json({ error: "boom" }, { status: 500 }));

        const harness = setup({ scopes: WRITE_SCOPES });
        const args = { idempotencyKey: "retry-me", prompt: "hello", threadId: "t1" };
        const failed = await harness.post(rpc("tools/call", { arguments: args, name: "send_message" }));

        expect(((await failed.json()) as { result: ToolResult }).result.structuredContent).toMatchObject({ error: { code: "internal_error" } });
        expect(harness.claims.size).toBe(0);

        const retried = await harness.post(rpc("tools/call", { arguments: args, name: "send_message" }));

        expect(((await retried.json()) as { result: ToolResult }).result.isError).toBe(false);
        expect(chatStart).toHaveBeenCalledTimes(2);
    });

    it("rejects an idempotencyKey the header would reject", async () => {
        const { result } = await send({}, { idempotencyKey: "has space", prompt: "hello", threadId: "t1" });

        expect(result?.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
        expect(chatStart).not.toHaveBeenCalled();
    });

    it("counts against the daily message limit, answering daily_limit_reached", async () => {
        chatStart.mockImplementation(async () => Response.json({ error: "DAILY_MESSAGE_LIMIT", message: "Daily limit reached." }, { status: 403 }));

        const { result } = await send({}, { prompt: "hello", threadId: "t1" });

        expect(chatStart).toHaveBeenCalledOnce();
        expect(result?.structuredContent).toMatchObject({ error: { code: "daily_limit_reached" } });
    });

    it("answers host_thread_read_only for a host-run thread, over MCP and REST", async () => {
        chatStart.mockImplementation(async () => Response.json({ error: "HOST_RUN_THREAD", message: "Send it from the desktop app." }, { status: 409 }));

        const { result } = await send({}, { prompt: "hello", threadId: "t1" });

        expect(result?.isError).toBe(true);
        expect(result?.structuredContent).toMatchObject({ error: { code: "host_thread_read_only" } });

        const rest = setup({ scopes: WRITE_SCOPES });
        const response = await rest.request("/chat", {
            body: JSON.stringify({ prompt: "hello", stream: false, threadId: "t1" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "host_thread_read_only" } });
    });

    it("returns waiting_on_person with the pending request as soon as the run pauses", async () => {
        const pendingRequest = { question: "Which environment?", toolCallId: "call1", toolName: "askUser" };
        const harness = setup({ chunks: { chunks: [{ text: "Let me check." }], pendingRequest, status: "done" }, scopes: WRITE_SCOPES });
        const response = await harness.post(rpc("tools/call", { arguments: { prompt: "deploy", threadId: "t1" }, name: "send_message" }));
        const { result } = (await response.json()) as { result: ToolResult };

        expect(result).toMatchObject({ isError: false, structuredContent: { pendingRequest, status: "waiting_on_person", text: "Let me check." } });
        expect(harness.calls.filter((entry) => entry.name === "chat_streaming_persistent_library:getChunksAfter")).toHaveLength(1);
    });
});

describe("MCP tool table", () => {
    const tools = buildMcpTools(ROUTES);

    it("has unique, well-formed tool names", () => {
        expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);

        for (const tool of tools) {
            expect(tool.name).toMatch(TOOL_NAME);
        }
    });

    it("tags reads, and as writes only the two chat tools, never a stream", () => {
        const writes = tools.filter((tool) => tool.route.method !== "get");

        expect(writes.map((tool) => tool.name)).toEqual(["create_thread", "send_message"]);

        for (const tool of tools) {
            expect(tool.route.response, tool.name).not.toBe("ndjson");
            expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.route.method === "get");
        }

        for (const tool of writes) {
            expect(tool.route.operationId, tool.name).toBe("createChat");
            expect(tool.route.scopes, tool.name).toEqual([["chat", "write"]]);
        }
    });

    it("tells the agent that what a tool returns is data, not instructions", () => {
        for (const tool of tools) {
            expect(tool.description, tool.name).toContain("not instructions");
        }
    });

    it("builds each input schema from the route's path and query parameters", () => {
        const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));

        expect(byName["read_messages"]).toMatchObject({
            additionalProperties: false,
            properties: { cursor: { type: "string" }, limit: { type: "string" }, threadId: { type: "string" } },
            required: ["threadId"],
        });
        expect(byName["search_knowledge"]).toMatchObject({ required: ["q"] });
        expect(byName["list_tasks"]).not.toHaveProperty("required");
    });
});

describe("MCP with a real client", () => {
    it("connects, lists the read tools and reads a thread", async () => {
        const harness = setup();
        const transport = new StreamableHTTPClientTransport(new URL("https://api.example/api/v1/mcp"), {
            fetch: harness.fetch as typeof fetch,
            requestInit: { headers: { Authorization: "Bearer nk_test" } },
        });
        const client = new Client({ name: "test-client", version: "1.0.0" });

        await client.connect(transport);

        try {
            const { tools } = await client.listTools();

            expect(tools.map((tool) => tool.name)).toEqual(["list_threads", "get_thread", "read_messages", "list_tasks", "get_task", "search_knowledge"]);

            const result = await client.callTool({ arguments: { threadId: "t1" }, name: "get_thread" });

            expect(result).toMatchObject({ isError: false, structuredContent: { id: "t1", title: "Plan" } });
        } finally {
            await client.close();
        }
    });
});

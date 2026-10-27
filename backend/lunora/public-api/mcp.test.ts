/**
 * The MCP endpoint through the real router: framing, the tool list, and that a
 * tool call is the route behind it — scopes, per-key limit and locked-thread
 * handling included — with a fake ctx standing in for the runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import type { LunoraHttpEnv } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";
import z from "zod/v4";

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
    identity?: object | null;
    limit?: { ok: boolean; retryAfter?: number };
    routes?: ReadonlyArray<RouteDefinition>;
    scopes?: ApiScopes;
    thread?: Record<string, unknown>;
    threadsFail?: unknown;
}

const setup = (fixture: Fixture = {}) => {
    const calls: { args: unknown; name: string }[] = [];
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
            mcp: [{ description: "Send a message.", tool: "send_message" }],
            method: "post",
            operationId: "fixtureSend",
            path: "/fixture/send",
            response: z.object({ sent: z.boolean() }),
            scopes: [["chat", "write"]],
            summary: "Send",
            tag: "Chat",
        };
        const fixture = { routes: [...ROUTES, sendMessage] };

        expect(await names(fixture)).not.toContain("send_message");

        const { calls, result } = await callTool(fixture, "send_message", {});

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
        const body = await jsonOf(unknown.post(rpc("tools/call", { name: "send_message" })));

        // No write tool exists in this slice, so a forced call to one names no tool at all.
        expect(body).toMatchObject({ error: { code: -32_602, message: "Unknown tool: send_message" } });

        const missing = await callTool({}, "get_thread", {});

        expect(missing.result?.structuredContent).toMatchObject({ error: { code: "invalid_request", message: "`threadId` is required." } });

        const extra = await callTool({}, "get_thread", { nope: "x", threadId: "t1" });

        expect(extra.result?.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
        expect(extra.calls.map((entry) => entry.name)).not.toContain("chat_functions:getThread");
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

    it("tags only read routes in this slice, none of them a stream", () => {
        for (const tool of tools) {
            expect(tool.route.method, tool.name).toBe("get");
            expect(tool.route.response, tool.name).not.toBe("ndjson");
            expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
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

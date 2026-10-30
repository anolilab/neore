/**
 * `send_message` through the real path: the router, the tool, `runChatStart` and the database, with only the agent
 * run (the jobs queue) replaced. One send takes one unit of the daily message limit, and a replay of its
 * idempotency key takes none.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { lunoraTest } from "@lunora/testing";
import { Hono } from "hono";
import type { LunoraHttpEnv } from "lunorash/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => new Map<string, unknown>());
const queue = vi.hoisted(() => {
    return { run: async (_args: Record<string, unknown>) => {} };
});

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi } = await import("../../test/registered-api");

    return registeredApi(await importOriginal(), registry);
});
vi.mock("../auth/lib/helper", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/helper")>()),
        getCurrentUserInternal: async () => {
            return { _id: "owner", isAnonymous: false };
        },
    };
});
vi.mock("../lib/http-shard", () => {
    return {
        inShard: async (ctx: unknown, _shardKey: string, handler: (ctx: unknown) => Promise<unknown>) => await handler(ctx),
        shardContext: (ctx: unknown) => ctx,
    };
});
// The agent run is the one piece replaced: it finishes the stream the way a run would.
vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: async (_ref: unknown, args: Record<string, unknown>) => {
            await queue.run(args);
        },
    };
});
vi.mock("../lib/http-scheduler", () => {
    return {
        httpScheduler: () => {
            return { runAfter: async () => {} };
        },
    };
});

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const { createRatelimit } = await import("../lib/rate-limiter");
const { createPublicApiRouter } = await import("./router");
const { addChunk } = await import("../chat/streaming/persistent/library");

registerModule(registry, "agent_messages", await import("../agent/messages"));
registerModule(registry, "agent_sharing", await import("../agent/sharing"));
registerModule(registry, "agent_threads", await import("../agent/threads"));
registerModule(registry, "auth_functions", await import("../auth/functions"));
registerModule(registry, "chat_functions", await import("../chat/functions"));
registerModule(registry, "chat_streaming", await import("../chat/streaming"));
registerModule(registry, "chat_streaming_persistent_library", await import("../chat/streaming/persistent/library"));
registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
registerModule(registry, "lib_shard_housekeeping", await import("../lib/shard-housekeeping"));

const DAILY_KEY = "chat/dailyText:free";

let harness: ReturnType<typeof lunoraTest>;

const run = async (reference: never, args: never) => await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));
const read = async (reference: never, args: never) => await harness.run(async (ctx: any) => await ctx.runQuery(reference, args));

const dailyRemaining = async (): Promise<number> => {
    const { remaining } = (await harness.run(async (ctx: any) => await createRatelimit(DAILY_KEY, ctx.db as never).getRemaining("owner"))) as {
        remaining: number;
    };

    return remaining;
};

const connect = async () => {
    const ctx = {
        auth: {
            getIdentity: async () => {
                return { apiKeyId: "key1", apiKeyScopes: { chat: ["write"] }, authMethod: "api_key" };
            },
            userId: "owner",
        },
        runAction: async () => {
            throw new Error("no actions here");
        },
        runMutation: run,
        runQuery: read,
    };
    const app = new Hono<LunoraHttpEnv>();

    app.use("*", async (c, next) => {
        (c as unknown as { set: (key: string, value: unknown) => void }).set("lunora", ctx);
        await next();
    });
    app.route("/api/v1", createPublicApiRouter());

    const client = new Client({ name: "test-client", version: "1.0.0" });

    await client.connect(
        new StreamableHTTPClientTransport(new URL("https://api.example/api/v1/mcp"), {
            fetch: (async (input: URL | string, init?: RequestInit) => await app.request(input, init)) as typeof fetch,
            requestInit: { headers: { Authorization: "Bearer nk_test" } },
        }),
    );

    return client;
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "secret");
    queue.run = async (args) => {
        await harness.run(async (ctx: any) => await ctx.runMutation(addChunk, { final: true, streamId: args["streamId"] as never, text: "Mock reply" }));
    };
    await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "owner@example.com", emailVerified: true, name: "O", updatedAt: 0 }),
    );
});

afterEach(() => {
    vi.unstubAllEnvs();
    harness.close();
});

describe("send_message through the real path", () => {
    it("takes one unit of the daily message limit per send, and none for a replay of the same key", async () => {
        const client = await connect();

        try {
            const before = await dailyRemaining();
            const sendArgs = { idempotencyKey: "daily-1", prompt: "hello" };
            const created = await client.callTool({ arguments: sendArgs, name: "create_thread" });

            expect(created).toMatchObject({ isError: false, structuredContent: { status: "done", text: "Mock reply" } });
            expect(await dailyRemaining()).toBe(before - 1);

            const replay = await client.callTool({ arguments: sendArgs, name: "create_thread" });

            expect(replay.structuredContent).toEqual(created.structuredContent);
            expect(await dailyRemaining()).toBe(before - 1);

            const { threadId } = created.structuredContent as { threadId: string };
            const sent = await client.callTool({ arguments: { prompt: "again", threadId }, name: "send_message" });

            expect(sent.isError).toBe(false);
            expect(await dailyRemaining()).toBe(before - 2);
        } finally {
            await client.close();
        }
    });
});

/**
 * `runChatStart` is the one turn-start path every caller shares (the app, the public API, the MCP server). A
 * host-run thread runs on a paired computer, so it refuses all of them, regenerate included (which skips the
 * access gate the plain continue goes through).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => new Map<string, unknown>());

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

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const { runChatStart } = await import("./http");
const { ROUTES } = await import("../public-api/routes");

registerModule(registry, "agent_sharing", await import("../agent/sharing"));
registerModule(registry, "agent_threads", await import("../agent/threads"));
registerModule(registry, "chat_functions", await import("./functions"));
registerModule(registry, "agent_messages", await import("../agent/messages"));
registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
registerModule(registry, "lib_shard_housekeeping", await import("../lib/shard-housekeeping"));

let harness: ReturnType<typeof lunoraTest>;

const httpContext = () => {
    const runners = {
        runAction: async () => {
            throw new Error("no actions here");
        },
        runMutation: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runMutation(ref, args)),
        runQuery: async (ref: never, args: never) => await harness.run(async (ctx: any) => await ctx.runQuery(ref, args)),
    };

    return { ...runners, auth: { getIdentity: async () => null, userId: "owner" }, forShard: () => runners } as never;
};

const insertThread = async (fields: Record<string, unknown> = {}) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "t", userId: "owner", ...fields }))) as string;

const streamCount = async (): Promise<number> => {
    const result = (await harness.run(async (ctx: any) => await ctx.db.persistentStreams.findMany({}))) as { page: unknown[] };

    return result.page.length;
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("runChatStart on a host-run thread", () => {
    it("refuses a plain send with 409 and starts nothing", async () => {
        const threadId = await insertThread({ runner: "host" });
        const response = await runChatStart(httpContext(), { model: "gpt-4o", prompt: "hello", threadId }, "secret");

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: "HOST_RUN_THREAD" });
        expect(await streamCount()).toBe(0);
    });

    it("refuses a regenerate, which skips the access gate", async () => {
        const threadId = await insertThread({ runner: "host" });
        const parentId = (await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: "hi", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "hi",
                    threadId,
                    tool: false,
                    userId: "owner",
                }),
        )) as string;
        const response = await runChatStart(httpContext(), { model: "gpt-4o", parentId, regenerate: true, threadId }, "secret");

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: "HOST_RUN_THREAD" });
        expect(await streamCount()).toBe(0);
    });

    it("answers a stranger's regenerate like any thread they cannot reach, not as a host thread", async () => {
        const regenerate = async (fields: Record<string, unknown>) => {
            const threadId = await insertThread({ userId: "someone-else", ...fields });
            const parentId = (await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("messages", {
                        message: { content: "hi", role: "user" },
                        order: 0,
                        status: "success",
                        stepOrder: 0,
                        text: "hi",
                        threadId,
                        tool: false,
                        userId: "someone-else",
                    }),
            )) as string;

            return await runChatStart(httpContext(), { model: "gpt-4o", parentId, regenerate: true, threadId }, "secret");
        };
        const hostResponse = await regenerate({ runner: "host" });
        const cloudResponse = await regenerate({});

        expect(hostResponse.status).not.toBe(409);
        expect(hostResponse.status).toBe(cloudResponse.status);
        expect(await hostResponse.json()).toEqual(await cloudResponse.json());
        expect(await streamCount()).toBe(0);
    });

    it("is answered host_thread_read_only by the public API chat route, which send_message shares", async () => {
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "secret");

        try {
            const threadId = await insertThread({ runner: "host" });
            const route = ROUTES.find((candidate) => candidate.operationId === "createChat");
            const input = {
                body: { prompt: "hello", stream: false, threadId },
                ctx: httpContext(),
                identity: { apiKeyId: "k1", apiKeyScopes: { chat: ["write"] }, authMethod: "api_key", userId: "owner" },
                params: {},
                query: {},
                signal: new AbortController().signal,
            };

            await expect(route?.handler(input as never)).rejects.toMatchObject({ code: "host_thread_read_only", status: 409 });
            expect(await streamCount()).toBe(0);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("control: the gate reports a host thread, and only a host thread", async () => {
        const { gateThreadActionHandler } = await import("./functions");
        const host = await insertThread({ runner: "host" });
        const cloud = await insertThread();
        const gate = async (threadId: string) =>
            await harness.run(async (ctx: any) => await gateThreadActionHandler(ctx, { level: "write", threadId: threadId as never, userId: "owner" }));

        await expect(gate(host)).resolves.toMatchObject({ hostRun: true, outcome: "ok" });
        await expect(gate(cloud)).resolves.not.toHaveProperty("hostRun");
    });
});

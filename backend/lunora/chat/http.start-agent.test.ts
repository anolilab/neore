/**
 * `/chat/start` on a thread whose agent was switched (plans/harness-switch.md, S1): the model the stream is
 * configured with comes from the thread's path, not from the composer, and only for a model the registry knows.
 * The thread, its rows and the lookups behind the gate are real; the runtime around the handler is faked.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAgentModelOf } from "../agent/agent-switch";
import schema from "../schema";
import { gateThreadActionHandler } from "./functions";
import { switchThreadAgentHandler } from "./agent-switch";
import { runChatStart } from "./http";

vi.mock("../auth/lib/helper", () => {
    return {
        getCurrentUserInternal: async () => {
            return { _id: "owner-user", isAnonymous: false };
        },
    };
});
vi.mock("../lib/thread-shard", () => {
    return { threadShardFor: async () => "shard" };
});
vi.mock("../lib/http-shard", () => {
    return { inShard: async (ctx: unknown, _shardKey: string, handler: (ctx: unknown) => Promise<unknown>) => await handler(ctx) };
});
vi.mock("../lib/job-queue", () => {
    return { enqueueJob: vi.fn(async () => {}) };
});
vi.mock("./lib/daily-limit", () => {
    return {
        chargeDailyLimit: async () => {
            return { ok: true };
        },
    };
});
vi.mock("./lib/get-agent", () => {
    return {
        default: async () => {
            return {
                saveMessage: async () => {
                    return { messageId: "saved-prompt" };
                },
            };
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

const OWNER = "owner-user";
const A = "openai/gpt-4.1-mini";
const B = "google/gemini-2.0-flash-001";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
const ids: Record<string, string> = {};
let streamingConfigs: { model: string }[] = [];
let agentModelQueries = 0;

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);

const insertRow = async (name: string, order: number, stepOrder: number, role: "assistant" | "user", value: string) => {
    ids[name] = await run(
        async (ctx) =>
            await ctx.db.insert("messages", {
                message: role === "user" ? { content: value, role } : { content: [{ text: value, type: "text" }], role },
                order,
                status: "success",
                stepOrder,
                text: value,
                threadId,
                tool: false,
                userId: OWNER,
            }),
    );
};

/** A runtime ctx whose lookups read the harness's rows. */
const fakeContext = (): any => {
    return {
        auth: { getIdentity: async () => null },
        runMutation: async (reference: { __lunoraRef: string }, args: any) => {
            if (reference.__lunoraRef === "chat_streaming:createStreamWithMessage") {
                streamingConfigs.push(args.streamingConfig);

                return "stream-1";
            }

            return null;
        },
        runQuery: async (reference: { __lunoraRef: string }, args: any) => {
            switch (reference.__lunoraRef) {
                case "agent_agent_switch:getRunAgentModel": {
                    agentModelQueries += 1;

                    return await run(async (ctx) => await runAgentModelOf(ctx, args));
                }
                case "agent_messages:getMessagesByIds": {
                    return await run(async (ctx) => await Promise.all(args.messageIds.map(async (id: string) => await ctx.db.get(id))));
                }
                case "agent_threads:getThreadInternal": {
                    return await run(async (ctx) => await ctx.db.get(args.threadId));
                }
                case "chat_functions:gateThreadAction": {
                    return await run(async (ctx) => await gateThreadActionHandler(ctx, args));
                }
                default: {
                    return null;
                }
            }
        },
    };
};

const start = async (body: Record<string, unknown>): Promise<Response> =>
    await runChatStart(fakeContext(), { model: A, prompt: "next", threadId, ...body } as never, "secret");

const switchTo = async (model: string) =>
    await run(
        async (ctx) =>
            await switchThreadAgentHandler(ctx, { clientId: `c-${model}`, target: { kind: "model", model }, threadId: threadId as never, userId: OWNER }),
    );

beforeEach(async () => {
    streamingConfigs = [];
    agentModelQueries = 0;
    harness = lunoraTest(schema as never);
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: A, status: "active", title: "T", userId: OWNER }));
    await insertRow("u1", 0, 0, "user", "hello");
    await insertRow("a1", 0, 1, "assistant", "hi");
});

afterEach(() => {
    harness.close();
});

describe("/chat/start after a switch", () => {
    it("runs a send on the thread's agent, not the composer's model", async () => {
        await switchTo(B);

        const response = await start({ model: A });

        expect(response.status).toBe(200);
        expect(streamingConfigs.at(-1)?.model).toBe(B);
    });

    it("keeps the composer's model for a thread that was never switched, without asking for an agent", async () => {
        const response = await start({ model: B });

        expect(response.status).toBe(200);
        expect(streamingConfigs.at(-1)?.model).toBe(B);
        expect(agentModelQueries).toBe(0);
    });

    it("runs a regenerate of a message before the switch on the model recorded on its path", async () => {
        await switchTo(B);

        const response = await start({ model: B, parentId: ids.u1, regenerate: true });

        expect(response.status).toBe(200);
        expect(streamingConfigs.at(-1)?.model).toBe(A);
    });

    it("does not let a pre-switch model outside the registry override a regenerate", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { model: "custom/local-llama" }));
        await switchTo(B);

        const response = await start({ model: A, parentId: ids.u1, regenerate: true });

        expect(response.status).toBe(200);
        expect(streamingConfigs.at(-1)?.model).toBe(A);
    });
});

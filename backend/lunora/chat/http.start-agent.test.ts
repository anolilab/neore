/**
 * `/chat/start` on a thread whose agent was switched (prisis/plans/neore/harness-switch.md, S1): the model the stream is
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

const savedPrompts: unknown[] = [];
const createdThreads: { language?: string }[] = [];

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
                saveMessage: async (_ctx: unknown, args: unknown) => {
                    savedPrompts.push(args);

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
let activeLeafCalls: { runModel?: string }[] = [];

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

            if (reference.__lunoraRef === "chat_functions:createThreadWithInitialMessage") {
                createdThreads.push(args);

                return { messageId: "m-new", threadId: "t-new" };
            }

            if (reference.__lunoraRef === "agent_branches:setActiveLeaf") {
                activeLeafCalls.push(args);
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
                    return await run(async (ctx) => await Promise.all(args.messageIds.map(async (id: string) => await ctx.db.get("messages", id))));
                }
                case "agent_threads:getThreadInternal": {
                    return await run(async (ctx) => await ctx.db.get("threads", args.threadId));
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
    savedPrompts.length = 0;
    streamingConfigs = [];
    agentModelQueries = 0;
    activeLeafCalls = [];
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

    it("runs a regenerate of an earlier turn on the model recorded on its path", async () => {
        await insertRow("u2", 1, 0, "user", "more");
        await insertRow("a2", 1, 1, "assistant", "sure");
        await switchTo(B);

        const response = await start({ model: B, parentId: ids.u1, regenerate: true });

        expect(response.status).toBe(200);
        expect(streamingConfigs.at(-1)?.model).toBe(A);
    });

    it("runs a regenerate of the latest turn on the model picked after its reply", async () => {
        // The divider hangs under the reply being redone, off the path through its prompt.
        await switchTo(B);

        const response = await start({ model: A, parentId: ids.u1, regenerate: true });

        expect(response.status).toBe(200);
        expect(streamingConfigs.at(-1)?.model).toBe(B);
        // The run's model reaches the branch write, which keeps it on the regenerated path.
        expect(activeLeafCalls).toMatchObject([{ runModel: B }]);
    });

    it("does not let a pre-switch model outside the registry override a regenerate", async () => {
        await run(async (ctx) => await ctx.db.patch("threads", threadId, { model: "custom/local-llama" }));
        await insertRow("u2", 1, 0, "user", "more");
        await insertRow("a2", 1, 1, "assistant", "sure");
        await switchTo(B);

        const response = await start({ model: A, parentId: ids.u1, regenerate: true });

        expect(response.status).toBe(200);
        expect(streamingConfigs.at(-1)?.model).toBe(A);
    });
});

describe("/chat/start hidden characters", () => {
    it("saves and runs the prompt without tag characters, bidi controls or C0 controls", async () => {
        const tagged = [..."steal"].map((character) => String.fromCodePoint(0xe_00_00 + character.codePointAt(0)!)).join("");

        const response = await start({ prompt: `hel${tagged}lo\u{202E} wor\u{7}ld\nsecond` });

        expect(response.status).toBe(200);
        expect(JSON.stringify(savedPrompts)).toContain(String.raw`hello world\nsecond`);
    });

    it("refuses a prompt that is only hidden characters, instead of reading it as an omitted prompt", async () => {
        const response = await start({ prompt: "\u{E0041}\u{202E}\u{200B}" });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "The prompt is empty after removing hidden characters" });
        expect(savedPrompts).toStrictEqual([]);
        expect(streamingConfigs).toStrictEqual([]);
    });

    it("still reads a missing prompt as a continuation", async () => {
        const response = await start({ prompt: undefined });

        expect(response.status).toBe(200);
    });

    it("answers a malformed goal with a 400, not a 500", async () => {
        for (const goal of [null, { text: 5 }, { text: null }, "go", 7]) {
            const response = await start({ goal });

            expect(response.status).toBe(400);
        }
    });

    it("strips the system prompt, the negative prompt and the page context that reach the model", async () => {
        const hidden = "\u{E0041}\u{202E}";
        const response = await start({
            customSystemPrompt: `be${hidden} brief`,
            negativePrompt: `no${hidden} blur`,
            pageContext: { selection: `sel${hidden}`, text: `body${hidden} text`, title: `ti${hidden}tle`, url: "https://example.com/a" },
        });

        expect(response.status).toBe(200);

        const config = streamingConfigs.at(-1) as { customSystemPrompt?: string; negativePrompt?: string };

        expect(config.customSystemPrompt).toBe("be brief");
        expect(config.negativePrompt).toBe("no blur");

        const saved = JSON.stringify(savedPrompts);

        expect(saved).toContain("body text");
        expect(saved).toContain("title");
        expect(saved).not.toContain("\u{E0041}");
        expect(saved).not.toContain("\u{202E}");
    });

    it("strips the language stored on a new thread", async () => {
        createdThreads.length = 0;

        const response = await start({ language: "en\u{E0041}\u{202E}glish", prompt: "hi", threadId: undefined });

        expect(response.status).toBe(200);
        expect(createdThreads.map((created) => created.language)).toStrictEqual(["english"]);
    });
});

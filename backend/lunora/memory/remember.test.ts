/**
 * "Remember this": the model only triggers it. The fact is worded by the extractor from the words the user typed in the
 * prompt they just sent, in a chat that is theirs alone, with memory on, and saved through extraction's own gate.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { documentTextPart } from "../chat/lib/attached-text";
import { addMessagesHandler } from "../agent/messages";
import { extractMemories } from "./extract";
import { saveMemoryBatch } from "./functions";
import { rememberFactFor, rememberResultOf } from "./remember";

const { generateText, registry } = vi.hoisted(() => {
    return { generateText: vi.fn(), registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        loadModelFilterRules: async () => {
            return {};
        },
    };
});
vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
        NoAllowedUtilityModelError: class extends Error {},
    };
});
// The harness action ctx has no `services`; dedup runs on text here.
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return {
        embedMany: async () => {
            throw new Error("no embeddings in this test");
        },
    };
});

const USER = "user-a";
const REPLY = "stream-1";
const ASK = "Remember this: I'm vegan, please.";

type Fact = { asked?: boolean; memory: string; quote: string; validUntil?: string };

/** The extractor's answer: each fact as a preference stated plainly, asked for unless it says otherwise. */
const answer = (facts: ReadonlyArray<Fact>) => {
    generateText.mockResolvedValue({
        output: {
            facts: facts.map((fact) => {
                return { asked: true, confidence: 90, importance: 70, type: "preference", ...fact };
            }),
        },
    });
};

let harness: ReturnType<typeof lunoraTest>;

type Setup = {
    botId?: true;
    memoryEnabled?: boolean;
    /** The prompt's stored content; a plain text by default. */
    prompt?: unknown;
    promptRow?: Record<string, unknown>;
    /** Rows saved under the prompt besides this reply's pending one. */
    replies?: ReadonlyArray<Record<string, unknown>>;
    subAgentChild?: true;
    thread?: Record<string, unknown>;
};

/** A thread with the user's prompt and this reply's pending row; returns the ids the tool would pass. */
const setUp = async (setup: Setup = {}) =>
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: setup.memoryEnabled ?? true, timezone: "UTC", userId: USER });

        const botId = setup.botId
            ? await ctx.db.insert("bots", { computerEnabled: false, instructions: "", model: "m", name: "Chef", userId: USER })
            : undefined;
        const threadId = await ctx.db.insert("threads", { botId, status: "active", userId: USER, ...setup.thread });
        const content = setup.prompt ?? ASK;
        // The row's text is the message as sent, attachments included.
        const text = typeof content === "string" ? content : (content as { text: string }[]).map((part) => part.text).join("\n\n");
        const promptId = await ctx.db.insert("messages", {
            message: { content, role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text,
            threadId,
            tool: false,
            ...setup.promptRow,
        });

        const pendingId = await ctx.db.insert("messages", { order: 0, status: "pending", stepOrder: 1, threadId, tool: false });

        const replies = setup.replies ?? [];

        for (const [index, row] of replies.entries()) {
            await ctx.db.insert("messages", {
                message: { content: "Noted.", role: "assistant" },
                order: 0,
                status: "success",
                stepOrder: 2 + index,
                threadId,
                tool: false,
                ...row,
            });
        }

        if (setup.subAgentChild) {
            await ctx.db.insert("subAgentRuns", {
                childThreadId: threadId,
                createdAt: 0,
                depth: 1,
                parentThreadId: "parent",
                status: "running",
                task: "t",
                updatedAt: 0,
                userId: USER,
            });
        }

        return { botId, pendingId, promptMessageId: promptId as string, text, threadId };
    });

const remember = async (ids: { promptMessageId: string; threadId: string }) =>
    await harness.action(
        async (ctx: any) =>
            await rememberFactFor(ctx, { promptMessageId: ids.promptMessageId, replyKey: REPLY, threadId: ids.threadId as never, userId: USER }),
    );

const memories = async (): Promise<Record<string, any>[]> => await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

/** The job a reply schedules for its prompt once it ends (`afterRun`). */
const extraction = (ids: { promptMessageId: string; text: string; threadId: string }) => {
    return {
        assistantResponse: "Noted.",
        promptAt: 1,
        promptMessageId: ids.promptMessageId,
        quotablePrompt: ids.text,
        threadId: ids.threadId,
        userId: USER,
        userMessage: ids.text,
    };
};

/** The prompt the extractor was given, for what reached the model. */
const extractorPrompt = (): string => (generateText.mock.calls[0]?.[0] as { prompt: string }).prompt;

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "memory_extract", await import("./extract"));
    registerModule(registry, "memory_remember", await import("./remember"));
    registerModule(registry, "lib_claim_once", await import("../lib/claim-once"));
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    generateText.mockReset();
});

describe(rememberFactFor, () => {
    it("saves what the extractor found asked for, quoted from the typed prompt, as requested", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp();

        await expect(remember(ids)).resolves.toStrictEqual({ facts: [{ asked: true, memory: "User is vegan", status: "saved" }], status: "saved" });

        const [row] = await memories();

        expect(row).toMatchObject({ evidence: { messageId: ids.promptMessageId, quote: "I'm vegan" }, source: "requested", threadId: ids.threadId });
        expect(row?.botId).toBeUndefined();
        // The model was told to keep only what the user asked for, and read no assistant reply.
        expect(extractorPrompt()).toContain('set "asked": true on each fact the User message explicitly asks you to remember');
        expect(extractorPrompt()).not.toContain("Assistant:");
    });

    it("keeps an exception the user gave, and saves a request in another language", async () => {
        answer([{ memory: "User is vegan, except on weekends", quote: "I'm vegan, except on weekends" }]);

        await expect(remember(await setUp({ prompt: "Remember: I'm vegan, except on weekends" }))).resolves.toMatchObject({ status: "saved" });

        harness.close();
        harness = lunoraTest(schema as never);
        answer([{ memory: "Nutzer ist Vegetarier", quote: "dass ich Vegetarier bin" }]);

        await expect(remember(await setUp({ prompt: "Merk dir, dass ich Vegetarier bin" }))).resolves.toMatchObject({
            facts: [{ asked: true, memory: "Nutzer ist Vegetarier", status: "saved" }],
        });
    });

    it("saves nothing when the message asks for nothing, or only asks a question", async () => {
        answer([]);

        await expect(remember(await setUp({ prompt: "I'm vegan" }))).resolves.toStrictEqual({ facts: [], status: "nothing_asked" });

        harness.close();
        harness = lunoraTest(schema as never);

        await expect(remember(await setUp({ prompt: "Am I a morning person?" }))).resolves.toStrictEqual({ facts: [], status: "nothing_asked" });
        expect(await memories()).toHaveLength(0);
    });

    it("gives the model only the typed words, and refuses a fact worded from an attachment", async () => {
        answer([{ memory: "User is allergic to nuts", quote: "allergic to nuts" }]);

        const ids = await setUp({ prompt: [{ text: "Remember this", type: "text" }, documentTextPart("notes.txt", "I am allergic to nuts")] });

        await expect(remember(ids)).resolves.toStrictEqual({ facts: [], status: "refused" });
        expect(extractorPrompt()).not.toContain("allergic");
        expect(await memories()).toHaveLength(0);
    });

    it("saves to the bot's scope in a chat with the user's bot", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const { botId, ...ids } = await setUp({ botId: true });

        await remember(ids);

        const [row] = await memories();

        expect(row?.botId).toBe(botId);
    });

    it("still reads the prompt as fresh once the reply has saved a step and opened the next", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const { pendingId, ...ids } = await setUp();

        // What a step's save writes (`agent/client/start.ts`): the step's rows named by the run, then a new pending row.
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    {
                        message: { content: [{ input: {}, toolCallId: "call-1", toolName: "dateTime", type: "tool-call" }], role: "assistant" },
                        replyId: REPLY,
                    },
                    {
                        message: {
                            content: [{ output: { type: "text", value: "now" }, toolCallId: "call-1", toolName: "dateTime", type: "tool-result" }],
                            role: "tool",
                        },
                        replyId: REPLY,
                    },
                    { message: { content: [], role: "assistant" }, status: "pending" },
                ],
                pendingMessageId: pendingId,
                promptMessageId: ids.promptMessageId,
                threadId: ids.threadId,
                userId: USER,
            } as never);
        });

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });
    });

    it.each([
        ["memory turned off", { memoryEnabled: false }, "memory_off"],
        ["a privacy marker in the message", { prompt: "🔒 Remember: I'm vegan" }, "private_marker"],
        ["a messenger conversation", { thread: { externalThreadId: "chat-1" } }, "not_private"],
        ["a temporary chat", { thread: { isTemporary: true } }, "not_private"],
        ["a locked chat", { thread: { lockedAt: 1 } }, "not_private"],
        ["a sub-agent's or worker's thread", { subAgentChild: true as const }, "not_private"],
        ["a row that is not the user's prompt", { promptRow: { message: { content: ASK, role: "assistant" } } }, "not_your_words"],
        // A regenerate, or a prompt a task or sub-agent wrote: its earlier reply belongs to another run.
        ["a prompt another run answered first", { replies: [{ replyId: undefined }] }, "not_your_words"],
    ])("saves nothing, and asks no model, with %s", async (_name, setup: Setup, status) => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        await expect(remember(await setUp(setup))).resolves.toStrictEqual({ facts: [], status });
        expect(generateText).not.toHaveBeenCalled();
        expect(await memories()).toHaveLength(0);
    });

    it("handles two calls for one message once: one asks the model, the other is told it was handled", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp();
        const results = await Promise.all([remember(ids), remember(ids)]);

        expect(results.map((result) => result.status).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["already_requested", "saved"]);
        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await memories()).toHaveLength(1);
    });

    it("confirms a memory that already holds the fact instead of adding one", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp();

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { lastConfirmedAt: 1, memory: "user is vegan", source: "auto", type: "preference", updatedAt: 1, userId: USER });
        });

        await expect(remember(ids)).resolves.toStrictEqual({ facts: [{ asked: true, memory: "user is vegan", status: "known" }], status: "already_known" });

        const rows = await memories();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.lastConfirmedAt).toBeGreaterThan(1);
    });

    it("confirms in the write a row that holds the fact's text, which the action's dedup did not pick", async () => {
        const ids = await setUp();
        const twin = await harness.run(
            async (ctx: any) => await ctx.db.insert("memories", { memory: "User is  VEGAN", source: "auto", type: "identity", updatedAt: 1, userId: USER }),
        );
        const fact = {
            confidence: 90,
            importance: 70,
            memory: "User is vegan",
            source: "requested" as const,
            threadId: ids.threadId,
            type: "preference" as const,
            userId: USER,
        };
        const saved = await harness.action(
            async (ctx: any) =>
                await ctx.runMutation(saveMemoryBatch, {
                    memories: [fact],
                    requested: { promptMessageId: ids.promptMessageId, replyKey: REPLY, threadId: ids.threadId, userId: USER },
                }),
        );

        expect(saved).toStrictEqual([{ known: twin, text: "User is  VEGAN" }]);
        expect(await memories()).toHaveLength(1);
    });

    it.each([
        ["memory is turned off", { memoryEnabled: false }, "userSettings", "memory_off"],
        ["the chat is made public", { isPublic: true }, "threads", "not_private"],
    ] as const)("writes nothing when %s while the extractor runs, and a later call may still save", async (_name, change, table, status) => {
        const ids = await setUp();
        const restore = table === "userSettings" ? { memoryEnabled: true } : { isPublic: false };
        const patch = async (fields: object) =>
            await harness.run(async (ctx: any) => {
                const row = table === "threads" ? await ctx.db.get("threads", ids.threadId) : await ctx.db.query("userSettings").first();

                await ctx.db.patch(table, row._id, fields);
            });

        generateText.mockImplementationOnce(async () => {
            await patch(change);

            return { output: { facts: [{ confidence: 90, importance: 70, memory: "User is vegan", quote: "I'm vegan", type: "preference" }] } };
        });

        await expect(remember(ids)).resolves.toStrictEqual({ facts: [], status });
        expect(await memories()).toHaveLength(0);

        await patch(restore);
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });
    });

    it("is the turn's one extraction: other facts are saved as usual, and the reply's own extraction then reads nothing again", async () => {
        answer([
            { memory: "User is vegan", quote: "I'm vegan" },
            { asked: false, memory: "User works as a nurse", quote: "I work as a nurse" },
        ]);

        const ids = await setUp({ prompt: "Remember that I'm vegan. I work as a nurse." });

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });

        // The job the reply schedules once it ends (`afterRun`), marked because the reply called `remember`.
        await harness.action(async (ctx: any) => {
            await ctx.runAction(extractMemories, { ...extraction(ids), afterRemember: true });
        });

        const rows = await memories();

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(rows.map(({ memory, source }) => [source, memory]).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual([
            ["auto", "User works as a nurse"],
            ["requested", "User is vegan"],
        ]);
    });

    it("leaves a reply that did not call remember to its usual extraction, whatever claim the prompt holds", async () => {
        answer([{ asked: false, memory: "User works as a nurse", quote: "I work as a nurse" }]);

        const ids = await setUp({ prompt: "I work as a nurse." });

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("idempotencyClaims", { claimedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, key: ids.promptMessageId, scope: "memory-remember" });
        });
        await harness.action(async (ctx: any) => {
            await ctx.runAction(extractMemories, extraction(ids));
        });

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await memories()).toHaveLength(1);
    });

    it("refuses a fact whose own wording names a health condition, whatever its quote says", async () => {
        answer([{ memory: "User has diabetes", quote: "I'm off sugar" }]);

        await expect(remember(await setUp({ prompt: "Remember: I'm off sugar" }))).resolves.toStrictEqual({ facts: [], status: "refused" });
        expect(await memories()).toHaveLength(0);
    });

    describe("a requested save's row that already holds the fact", () => {
        const save = async (ids: { promptMessageId: string; threadId: string }, mem: object) =>
            await harness.action(
                async (ctx: any) =>
                    await ctx.runMutation(saveMemoryBatch, {
                        memories: [
                            {
                                confidence: 90,
                                importance: 70,
                                memory: "User flies to Paris",
                                source: "requested",
                                threadId: ids.threadId,
                                type: "activity",
                                userId: USER,
                                ...mem,
                            },
                        ],
                        requested: { promptMessageId: ids.promptMessageId, replyKey: REPLY, threadId: ids.threadId, userId: USER },
                    }),
            );
        const insert = async (row: object) =>
            await harness.run(async (ctx: any) => await ctx.db.insert("memories", { source: "auto", type: "activity", updatedAt: 1, userId: USER, ...row }));

        it("is another statement when its dates differ: the fact is saved beside it", async () => {
            const ids = await setUp();

            await insert({ eventStart: "2026-12-01", memory: "User flies to Paris" });

            const [saved] = await save(ids, { eventStart: "2026-12-05" });

            expect(typeof saved).toBe("string");
            expect(await memories()).toHaveLength(2);
        });

        it("is confirmed, and what the fact was to supersede is retired in its favour", async () => {
            const ids = await setUp();
            const known = await insert({ memory: "User flies to Paris" });
            const old = await insert({ memory: "User flies to Rome" });

            await expect(save(ids, { supersedes: old, supersedesBase: "User flies to Rome" })).resolves.toStrictEqual([{ known, text: "User flies to Paris" }]);

            const rows = await memories();

            expect(rows.find((row) => row._id === old)?.supersededBy).toBe(known);
            expect(rows).toHaveLength(2);
        });
    });
});

describe(rememberResultOf, () => {
    const vegan = { asked: true, memory: "User is vegan", status: "saved" as const };

    it("lists what was written before a refusal stopped the request, and keeps the prompt handled", () => {
        expect(rememberResultOf({ asked: true, blocked: "memory_off", facts: [vegan], refused: 0 })).toStrictEqual({
            keepClaim: true,
            result: { facts: [vegan], status: "saved", stopped: "memory_off" },
        });
    });

    it("gives a refusal before any write as the reason, and leaves the prompt to a later call", () => {
        expect(rememberResultOf({ asked: true, blocked: "not_private", facts: [], refused: 0 })).toStrictEqual({
            keepClaim: false,
            result: { facts: [], status: "not_private" },
        });
    });
});

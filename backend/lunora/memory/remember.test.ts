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
import { enableThreadLock } from "../agent/thread-lock";
import { extractMemories } from "./extract";
import { internal } from "../_generated/internal";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { saveMemoryBatch } from "./functions";
import { rememberFactFor, rememberResultOf } from "./remember";
import { rememberDispatchInFlight } from "./remember-dispatch";

const { generateText, getUtilityModel, registry } = vi.hoisted(() => {
    return {
        generateText: vi.fn(),
        getUtilityModel: vi.fn(async () => {
            return {};
        }),
        registry: new Map<string, unknown>(),
    };
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
    return { getUtilityModel, NoAllowedUtilityModelError: class extends Error {} };
});
vi.mock("../lib/shard-scheduler", async (importOriginal) => {
    const original = await importOriginal<typeof import("../lib/shard-scheduler")>();

    return { ...original, runAfterOnShard: vi.fn(original.runAfterOnShard) };
});
// The owner's lock attempt reads its identity from the harness.
vi.mock("../auth/session", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/session")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
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
// Built at run time, so no token-shaped literal sits in the source.
const TOKEN = ["gh", "p_", "Zq8LmV2xR7tYw4KpN3bC9dF6hJ1sA5gE0uIo"].join("");

type Fact = { asked?: boolean; memory: string; quote: string; sensitive?: boolean; validUntil?: string };

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
        const tags = setup.subAgentChild ? ["sub-agent"] : ["chat"];
        const threadId = await ctx.db.insert("threads", { botId, status: "active", tags, userId: USER, ...setup.thread });
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
    registerModule(registry, "agent_thread_lock", await import("../agent/thread-lock"));
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

    it("says nothing asked, not refused, when only an unasked fact failed the quote check", async () => {
        // The question asks nothing to be remembered; the ordinary fact found beside it quotes words the user never typed.
        answer([{ asked: false, memory: "User gets up early", quote: "I always get up at five" }]);

        await expect(remember(await setUp({ prompt: "I get up early. What should I eat first?" }))).resolves.toStrictEqual({
            facts: [],
            status: "nothing_asked",
        });
        expect(await memories()).toHaveLength(0);
    });

    it("saves a request typed after a long attachment: its quote is read where the model read it", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp({
            prompt: [
                { text: "Here are my notes.", type: "text" },
                documentTextPart("notes.txt", "Lorem ipsum dolor sit amet. ".repeat(200)),
                { text: "Remember that I'm vegan.", type: "text" },
            ],
        });

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });
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
        ["a task's thread", { thread: { tags: ["task"] } }, "not_private"],
        ["a row that is not the user's prompt", { promptRow: { message: { content: ASK, role: "assistant" } } }, "not_your_words"],
        // A prompt a task or sub-agent wrote and another run already answered: its completed reply is another run's.
        ["a prompt another run answered first", { replies: [{ replyId: "stream-0" }] }, "not_your_words"],
        // A regenerate: the earlier reply's rows, then this reply's.
        ["a regenerate of an answered prompt", { replies: [{ replyId: "stream-0" }, { replyId: "stream-0" }, { replyId: REPLY }] }, "not_your_words"],
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

    it("is the turn's one extraction: other facts are saved as usual, and the reply's own jobs then read nothing again", async () => {
        answer([
            { memory: "User is vegan", quote: "I'm vegan" },
            { asked: false, memory: "User works as a nurse", quote: "I work as a nurse" },
        ]);

        const ids = await setUp({ prompt: "Remember that I'm vegan. I work as a nurse." });

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });

        // The jobs the reply schedules for its prompt (`afterRun`): at an approval pause and at its end, or after a resume, each
        // knowing only its own segment's rows.
        const runJob = async () =>
            await harness.action(async (ctx: any) => {
                await ctx.runAction(extractMemories, extraction(ids));
            });

        await runJob();
        await runJob();

        const rows = await memories();

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(rows.map(({ memory, source }) => [source, memory]).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual([
            ["auto", "User works as a nurse"],
            ["requested", "User is vegan"],
        ]);
    });

    it("extracts a prompt no remember call holds as usual", async () => {
        answer([{ asked: false, memory: "User works as a nurse", quote: "I work as a nurse" }]);

        const ids = await setUp({ prompt: "I work as a nurse." });

        await harness.action(async (ctx: any) => {
            await ctx.runAction(extractMemories, extraction(ids));
        });

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await memories()).toHaveLength(1);
    });

    it("saves a fact the extractor returned twice, asked only the second time, as asked", async () => {
        answer([
            { asked: false, memory: "User is vegan", quote: "I'm vegan" },
            { memory: "user is vegan", quote: "I'm vegan" },
        ]);

        await expect(remember(await setUp())).resolves.toStrictEqual({ facts: [{ asked: true, memory: "User is vegan", status: "saved" }], status: "saved" });
        const rows = await memories();

        expect(rows.map((row) => row.source)).toStrictEqual(["requested"]);
    });

    it("saves one asked row, listed once, for a statement returned unasked first with other inner spacing", async () => {
        answer([
            { asked: false, memory: "User  is   vegan", quote: "I'm vegan" },
            { memory: "User is vegan", quote: "I'm vegan" },
        ]);

        const result = await remember(await setUp());

        expect(result).toMatchObject({ status: "saved" });
        expect(result.facts).toHaveLength(1);
        expect(result.facts[0]).toMatchObject({ asked: true, status: "saved" });
        const rows = await memories();

        expect(rows.map((row) => row.source)).toStrictEqual(["requested"]);
    });

    it("saves an unrelated fact beside an asked health fact, and says the asked one was refused and why", async () => {
        answer([
            { memory: "User takes Prozac", quote: "I take Prozac", sensitive: true },
            { asked: false, memory: "User works as a nurse", quote: "I work as a nurse" },
        ]);

        await expect(remember(await setUp({ prompt: "Remember I take Prozac. I work as a nurse." }))).resolves.toStrictEqual({
            facts: [{ asked: false, memory: "User works as a nurse", status: "saved" }],
            refused: ["health"],
            status: "saved",
        });
        const rows = await memories();

        expect(rows.map((row) => row.memory)).toStrictEqual(["User works as a nurse"]);
    });

    it("names a health word the quote check refused as health, not as unbacked, beside a saved fact", async () => {
        answer([
            { memory: "User sees a doctor weekly", quote: "I see a doctor weekly" },
            { asked: false, memory: "User works as a teacher", quote: "I work as a teacher" },
        ]);

        await expect(remember(await setUp({ prompt: "Remember I see a doctor weekly. I work as a teacher." }))).resolves.toStrictEqual({
            facts: [{ asked: false, memory: "User works as a teacher", status: "saved" }],
            refused: ["health"],
            status: "saved",
        });
    });

    it("saves a short asked fact the quote backs, which an unasked one that short is not", async () => {
        answer([{ memory: "User skis", quote: "I ski" }]);

        await expect(remember(await setUp({ prompt: "Remember that I ski" }))).resolves.toStrictEqual({
            facts: [{ asked: true, memory: "User skis", status: "saved" }],
            status: "saved",
        });

        const rows = await memories();

        expect(rows.map((row) => [row.memory, row.source])).toStrictEqual([["User skis", "requested"]]);

        harness.close();
        harness = lunoraTest(schema as never);
        answer([{ asked: false, memory: "User skis", quote: "I ski" }]);

        await expect(remember(await setUp({ prompt: "Remember that I ski" }))).resolves.toMatchObject({ status: "nothing_asked" });
        expect(await memories()).toHaveLength(0);
    });

    it("sends the model nothing when the chat is locked after the request took the prompt", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp();

        // Resolving the model comes after the claim and right before the call: the lock lands in between.
        getUtilityModel.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.patch("threads", ids.threadId, { lockedAt: Date.now() });
            });

            return {};
        });

        await expect(remember(ids)).resolves.toStrictEqual({ facts: [], status: "not_private" });
        expect(generateText).not.toHaveBeenCalled();
        expect(await memories()).toHaveLength(0);
    });

    it("makes a lock attempted while the model call is out wait, and lets it through once the call is answered", async () => {
        const ids = await setUp();
        const inFlight = async () => await harness.run(async (ctx: any) => await rememberDispatchInFlight(ctx, ids.threadId as never));
        // Locking a chat mints an unlock proof, which needs the signing secret.
        const previousSecret = process.env.STORAGE_SIGNING_SECRET;
        const lock = async () =>
            await harness
                .withIdentity({ userId: USER } as never)
                .mutation(enableThreadLock as never, { passcode: "correct horse battery", threadId: ids.threadId } as never);
        let lockDuringCall: unknown;

        process.env.STORAGE_SIGNING_SECRET = "test-unlock-secret";

        try {
            // After the recheck, while the prompt is with the provider: the owner locks the chat, and the lock is refused.
            generateText.mockImplementationOnce(async () => {
                lockDuringCall = await lock().catch((error: unknown) => error);

                return {
                    output: { facts: [{ asked: true, confidence: 90, importance: 70, memory: "User is vegan", quote: "I'm vegan", type: "preference" }] },
                };
            });

            await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });
            expect(lockDuringCall).toMatchObject({ code: "CONFLICT" });
            await expect(inFlight()).resolves.toBe(false);
            await expect(lock()).resolves.toBeDefined();
        } finally {
            if (previousSecret === undefined) {
                delete process.env.STORAGE_SIGNING_SECRET;
            } else {
                process.env.STORAGE_SIGNING_SECRET = previousSecret;
            }
        }
    });

    it("refuses a fact the extractor marks as about the user's health, and keeps a job in the field", async () => {
        answer([{ memory: "User takes Prozac", quote: "I take Prozac", sensitive: true }]);

        await expect(remember(await setUp({ prompt: "Remember I take Prozac" }))).resolves.toStrictEqual({ facts: [], status: "refused" });
        expect(await memories()).toHaveLength(0);

        harness.close();
        harness = lunoraTest(schema as never);
        // Unmarked, a job in the field is kept. (A quote the quote check reads as health, "cancer research" or "therapist"
        // among them, is still refused by it, as on main.)
        answer([{ memory: "User works as a nurse", quote: "I work as a nurse" }]);

        await expect(remember(await setUp({ prompt: "Remember I work as a nurse" }))).resolves.toMatchObject({ status: "saved" });
    });

    it("reads past the reply's own rows: 60 tool rows before the call leave the prompt fresh", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const replies = Array.from({ length: 60 }, () => {
            return { replyId: REPLY };
        });

        await expect(remember(await setUp({ replies }))).resolves.toMatchObject({ status: "saved" });
    });

    it("reports an asked fact that was nothing but a secret as refused, and leaves the message to a later call", async () => {
        answer([{ memory: TOKEN, quote: TOKEN }]);

        const ids = await setUp({ prompt: `Remember my token ${TOKEN}` });

        await expect(remember(ids)).resolves.toStrictEqual({ facts: [], status: "refused" });

        answer([]);

        await expect(remember(ids)).resolves.toMatchObject({ status: "nothing_asked" });
        expect(await memories()).toHaveLength(0);
    });

    it("reads an approval's answer to the reply's own tool call, and the steps after it, as part of the reply", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        // The reply's call, then the result an approval saved outside any run, under the same prompt.
        const replies = [
            { message: { content: [{ input: {}, toolCallId: "call-1", toolName: "dateTime", type: "tool-call" }], role: "assistant" }, replyId: REPLY },
            {
                message: {
                    content: [
                        { approvalId: "approval-1", approved: true, type: "tool-approval-response" },
                        { output: { type: "text", value: "now" }, toolCallId: "call-1", toolName: "dateTime", type: "tool-result" },
                    ],
                    role: "tool",
                },
            },
        ];

        await expect(remember(await setUp({ replies }))).resolves.toMatchObject({ status: "saved" });

        harness.close();
        harness = lunoraTest(schema as never);

        // The continuation's later tool step carries no reply either: still this reply's.
        const furtherStep = [
            ...replies,
            { message: { content: [{ input: {}, toolCallId: "call-2", toolName: "dateTime", type: "tool-call" }], role: "assistant" } },
            {
                message: {
                    content: [{ output: { type: "text", value: "later" }, toolCallId: "call-2", toolName: "dateTime", type: "tool-result" }],
                    role: "tool",
                },
            },
        ];

        await expect(remember(await setUp({ replies: furtherStep }))).resolves.toMatchObject({ status: "saved" });
    });

    it("reads no further than the cap for another run's reply: a reply with very large tool rows still saves", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        // 150 of the reply's own tool rows, each carrying a large result. Only two pages are read: a row of another run past
        // them (here the last) is never reached, and the prompt counts as fresh, as an attribution check may.
        const result = "x".repeat(20_000);
        const replies = Array.from({ length: 150 }, (_, index) => {
            return {
                message: {
                    content: [{ output: { type: "text", value: result }, toolCallId: `call-${String(index)}`, toolName: "fetch", type: "tool-result" }],
                    role: "tool",
                },
                replyId: index === 149 ? "stream-0" : REPLY,
            };
        });

        await expect(remember(await setUp({ replies }))).resolves.toMatchObject({ status: "saved" });
    });

    it("frees the prompt by itself when a request's claim was never given back, and holds a handled one for a day", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp();
        const claimOf = async () => await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").first());

        // A request that died without its release: its claim lapsed after the few minutes a running one is held.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("idempotencyClaims", { claimedAt: 1, expiresAt: 2, key: ids.promptMessageId, scope: "memory-remember" });
        });

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });

        const claim = await claimOf();

        expect(claim).toMatchObject({ result: "done" });
        expect(claim.expiresAt - claim.claimedAt).toBe(24 * 60 * 60 * 1000);
    });

    it("marks the prompt handled though the request's claim lapsed while it ran", async () => {
        const ids = await setUp();

        generateText.mockImplementationOnce(async () => {
            // The running claim lapses before the write: nothing holds the prompt when the request marks it done.
            await harness.run(async (ctx: any) => {
                const claim = await ctx.db.query("idempotencyClaims").first();

                await ctx.db.patch("idempotencyClaims", claim._id, { expiresAt: 0 });
            });

            return { output: { facts: [{ asked: true, confidence: 90, importance: 70, memory: "User is vegan", quote: "I'm vegan", type: "preference" }] } };
        });

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });

        const claim = await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").first());

        expect(claim).toMatchObject({ result: "done", userId: USER });
        expect(claim.expiresAt).toBeGreaterThan(Date.now());
    });

    it("marks nothing when a newer request took the prompt after this one's claim lapsed", async () => {
        const ids = await setUp();
        let newer: number | undefined;

        generateText.mockImplementationOnce(async () => {
            // This request's claim lapses, and a newer request takes the prompt while this one still runs.
            await harness.run(async (ctx: any) => {
                const claim = await ctx.db.query("idempotencyClaims").first();

                newer = claim.claimedAt + 1;
                await ctx.db.delete("idempotencyClaims", claim._id);
                await ctx.db.insert("idempotencyClaims", {
                    claimedAt: newer,
                    expiresAt: Number.MAX_SAFE_INTEGER,
                    key: ids.promptMessageId,
                    scope: "memory-remember",
                });
            });

            return { output: { facts: [{ asked: true, confidence: 90, importance: 70, memory: "User is vegan", quote: "I'm vegan", type: "preference" }] } };
        });

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });

        const claim = await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").first());

        expect(claim.claimedAt).toBe(newer);
        expect(claim.result).toBeUndefined();
    });

    it("returns the saved facts when marking the prompt handled fails", async () => {
        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const result = await harness.action(async (ctx: any) => {
            // Only the done mark is sent `claimedAt` without a `scope`.
            const failing = Object.create(ctx, {
                runMutation: {
                    value: async (reference: unknown, args: Record<string, unknown>) => {
                        if ("claimedAt" in args && !("scope" in args)) {
                            throw new Error("done mark failed");
                        }

                        return await ctx.runMutation(reference, args);
                    },
                },
            });

            return await rememberFactFor(failing, { promptMessageId: ids.promptMessageId, replyKey: REPLY, threadId: ids.threadId as never, userId: USER });
        });

        expect(result).toStrictEqual({ facts: [{ asked: true, memory: "User is vegan", status: "saved" }], status: "saved" });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be marked handled"), expect.any(Error));
        expect(await memories()).toHaveLength(1);
        warn.mockRestore();
    });

    it("gives the prompt back when the model answers with no facts list", async () => {
        generateText.mockResolvedValueOnce({ output: undefined });

        const ids = await setUp();

        await expect(remember(ids)).resolves.toStrictEqual({ facts: [], status: "unavailable" });

        answer([{ memory: "User is vegan", quote: "I'm vegan" }]);

        await expect(remember(ids)).resolves.toMatchObject({ status: "saved" });
    });

    it("still extracts the turn when the remember call's model failed", async () => {
        generateText.mockRejectedValueOnce(new Error("model down"));

        const ids = await setUp();

        await expect(remember(ids)).resolves.toMatchObject({ status: "unavailable" });

        answer([{ asked: false, memory: "User is vegan", quote: "I'm vegan" }]);
        await harness.action(async (ctx: any) => {
            await ctx.runAction(extractMemories, extraction(ids));
        });

        expect(await memories()).toHaveLength(1);
    });

    it("waits for a remember call still running instead of reading or dropping the prompt", async () => {
        answer([{ asked: false, memory: "User is vegan", quote: "I'm vegan" }]);

        const ids = await setUp();

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("idempotencyClaims", { claimedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, key: ids.promptMessageId, scope: "memory-remember" });
        });
        vi.mocked(runAfterOnShard).mockClear();
        await harness.action(async (ctx: any) => {
            await ctx.runAction(extractMemories, extraction(ids));
        });

        expect(generateText).not.toHaveBeenCalled();
        expect(vi.mocked(runAfterOnShard).mock.calls).toStrictEqual([
            [expect.anything(), 30_000, internal.memory.extract.extractMemories, { ...extraction(ids), rememberWaits: 1 }, USER],
        ]);

        // Each wait runs the job its predecessor scheduled; past its last wait the job reads the prompt as usual, so a call
        // that never ended never costs the turn its facts.
        for (let wait = 1; wait <= 3; wait += 1) {
            const [, delay, , scheduled] = vi.mocked(runAfterOnShard).mock.calls.at(-1)!;

            expect([delay, (scheduled as { rememberWaits: number }).rememberWaits]).toStrictEqual([30_000, wait]);

            await harness.action(async (ctx: any) => {
                await ctx.runAction(extractMemories, scheduled);
            });
        }

        expect(runAfterOnShard).toHaveBeenCalledTimes(3);
        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await memories()).toHaveLength(1);
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

        it("is never a row an earlier fact of the same batch retired", async () => {
            const ids = await setUp();
            const old = await insert({ memory: "User flies to Rome" });
            const saved = await harness.action(
                async (ctx: any) =>
                    await ctx.runMutation(saveMemoryBatch, {
                        memories: [
                            { memory: "User flies to Paris", supersedes: old, supersedesBase: "User flies to Rome" },
                            { memory: "User flies to Rome" },
                        ].map((fact) => {
                            return { confidence: 90, importance: 70, source: "requested", threadId: ids.threadId, type: "activity", userId: USER, ...fact };
                        }),
                        requested: { promptMessageId: ids.promptMessageId, replyKey: REPLY, threadId: ids.threadId, userId: USER },
                    }),
            );
            const rows = await memories();

            expect(saved.every((entry: unknown) => typeof entry === "string")).toBe(true);
            expect(
                rows
                    .filter((row) => row.supersededBy === undefined)
                    .map((row) => row.memory)
                    .toSorted((a, b) => a.localeCompare(b)),
            ).toStrictEqual(["User flies to Paris", "User flies to Rome"]);
            expect(rows.find((row) => row._id === old)?.supersededBy).toBeDefined();
        });

        it("brings the request's quote to a row that has none", async () => {
            const ids = await setUp();
            const known = await insert({ memory: "User flies to Paris" });
            const evidence = { at: 1, messageId: ids.promptMessageId, quote: "I fly to Paris", threadId: ids.threadId };

            await expect(save(ids, { evidence })).resolves.toStrictEqual([{ known, text: "User flies to Paris" }]);

            const [row] = await memories();

            expect(row?.evidence).toStrictEqual(evidence);
        });

        it("is the first of two facts of one request that differ only in spacing and case: one row is saved", async () => {
            const ids = await setUp();
            const saved = await harness.action(
                async (ctx: any) =>
                    await ctx.runMutation(saveMemoryBatch, {
                        memories: ["User flies to Paris", "user  flies to PARIS"].map((memory) => {
                            return { confidence: 90, importance: 70, memory, source: "requested", threadId: ids.threadId, type: "activity", userId: USER };
                        }),
                        requested: { promptMessageId: ids.promptMessageId, replyKey: REPLY, threadId: ids.threadId, userId: USER },
                    }),
            );
            const [first] = saved;

            expect(typeof first).toBe("string");
            expect(saved).toStrictEqual([first, { known: first, text: "User flies to Paris" }]);
            expect(await memories()).toHaveLength(1);
        });
    });
});

describe(rememberResultOf, () => {
    const vegan = { asked: true, memory: "User is vegan", status: "saved" as const };

    it("lists what was written before a refusal stopped the request, and keeps the prompt handled", () => {
        expect(rememberResultOf({ asked: true, blocked: "memory_off", facts: [vegan], refused: 0, refusedAsked: [] })).toStrictEqual({
            keepClaim: true,
            result: { facts: [vegan], status: "saved", stopped: "memory_off" },
        });
    });

    it("says saved when anything new was written, though what was asked was already known", () => {
        const known = { asked: true, memory: "User is vegan", status: "known" as const };
        const nurse = { asked: false, memory: "User works as a nurse", status: "saved" as const };

        expect(rememberResultOf({ asked: true, facts: [known, nurse], refused: 0, refusedAsked: [] }).result.status).toBe("saved");
        expect(rememberResultOf({ asked: true, facts: [known], refused: 0, refusedAsked: [] }).result.status).toBe("already_known");
    });

    it("says refused, not nothing asked, when the asked fact was refused and the rest was already known", () => {
        const known = { asked: false, memory: "User works as a nurse", status: "known" as const };

        expect(rememberResultOf({ asked: true, facts: [known], refused: 1, refusedAsked: ["health"] })).toStrictEqual({
            keepClaim: true,
            result: { facts: [known], refused: ["health"], status: "refused" },
        });
        expect(rememberResultOf({ asked: true, facts: [known], refused: 0, refusedAsked: [] }).result.status).toBe("nothing_asked");
    });

    it("gives a refusal before any write as the reason, and leaves the prompt to a later call", () => {
        expect(rememberResultOf({ asked: true, blocked: "not_private", facts: [], refused: 0, refusedAsked: [] })).toStrictEqual({
            keepClaim: false,
            result: { facts: [], status: "not_private" },
        });
    });
});

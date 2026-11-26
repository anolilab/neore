/**
 * The daily schedule-ideas job against the real schema: what the model is sent (the person's typed words, nothing
 * else, and bounded), that a day is taken once, who is skipped, and that every proposal goes through the validating
 * insert. The model, the gateway and the jobs queue are mocked; what they receive is the assertion.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import {
    IDEA_ROWS_READ_PER_THREAD,
    MAX_IDEA_MESSAGE_CHARS,
    MAX_IDEA_PROPOSALS,
    MAX_IDEA_SOURCE_CHARS,
    MAX_IDEA_SOURCE_MESSAGES,
    scheduleIdeasDayKey,
    SCHEDULE_IDEAS_WINDOW_MS,
    takeIdeaSources,
    toSuggestions,
} from "./schedule-ideas-logic";
import { dispatchScheduleIdeas, generateScheduleIdeas, prepareScheduleIdeas } from "./schedule-ideas";

const { enqueued, generateText, getUtilityModel, registry } = vi.hoisted(() => {
    return {
        enqueued: [] as { args: unknown; options: unknown }[],
        generateText: vi.fn(),
        getUtilityModel: vi.fn(),
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
    return { getUtilityModel };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: async (_ref: unknown, args: unknown, options: unknown) => {
            enqueued.push({ args, options });
        },
    };
});

// Built from parts, so the repo holds no key-shaped literal.
const KEY = ["sk", "live", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-"); // secret-scanner:allow a fake key for the filter tests
/** A numbered message line of the prompt. */
const NUMBERED_LINE = /^\[\d+\] /;
const USER = "user-a";
const OTHER = "user-b";
const DAY = 24 * 60 * 60 * 1000;

let harness: ReturnType<typeof lunoraTest>;

const settings = async (fields: Record<string, unknown> = {}, userId = USER) =>
    await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { memoryEnabled: true, scheduleIdeasEnabled: true, userId, ...fields }));

const thread = async (fields: Record<string, unknown> = {}, userId = USER): Promise<string> =>
    await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { status: "regular", tags: ["chat"], title: "Chat", updatedAt: Date.now(), userId, ...fields }),
    );

let order = 0;

const row = async (threadId: string, role: "assistant" | "user", text: string, fields: Record<string, unknown> = {}): Promise<void> => {
    order += 1;
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: { content: text, role },
                order,
                status: "success",
                stepOrder: 0,
                text,
                threadId,
                tool: false,
                // A user row's typed words, as `typedTextColumn` writes them; every other row has none.
                ...(role === "user" && { typedText: text }),
                userId: USER,
                ...fields,
            }),
    );
};

const run = async (userId = USER) => await harness.action(async (ctx: any) => await ctx.runAction(generateScheduleIdeas, { userId }));

const prepare = async (userId = USER) => await harness.run(async (ctx: any) => await ctx.runMutation(prepareScheduleIdeas, { userId }));

const suggestions = async (): Promise<any[]> => await harness.run(async (ctx: any) => await ctx.db.query("taskSuggestions").collect());

const promptSent = (): string => generateText.mock.calls[0]![0].prompt as string;

const idea = (overrides: Record<string, unknown> = {}) => {
    return { cronExpression: "0 9 * * 1", instructions: "Summarise last week's notes", sources: [1], title: "Weekly notes", ...overrides };
};

beforeAll(async () => {
    registerModule(registry, "tasks_schedule_ideas", await import("./schedule-ideas"));
    registerModule(registry, "tasks_suggestions", await import("./suggestions"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    order = 0;
    enqueued.length = 0;
    getUtilityModel.mockResolvedValue({});
    generateText.mockResolvedValue({ output: { ideas: [idea()] } });
});

afterEach(() => {
    generateText.mockReset();
    getUtilityModel.mockReset();
});

describe("what the model is sent", () => {
    it("is the person's own typed messages only, never an assistant reply, tool output or an attachment-only message", async () => {
        await settings();
        const threadId = await thread();

        await row(threadId, "user", "every monday I need a summary of my notes");
        await row(threadId, "assistant", "ASSISTANT-REPLY-TEXT");
        await row(threadId, "assistant", "TOOL-OUTPUT-TEXT", { tool: true });
        // A user row with no typed words (an attachment or a quote only) has no `typedText`.
        await row(threadId, "user", "ATTACHED-FILE-TEXT", { typedText: undefined });
        // Another person's row in the same chat is never read.
        await row(threadId, "user", "SOMEONE-ELSES-WORDS", { userId: OTHER });

        await run();

        expect(generateText).toHaveBeenCalledOnce();
        expect(promptSent()).toContain("every monday I need a summary of my notes");

        for (const hidden of ["ASSISTANT-REPLY-TEXT", "TOOL-OUTPUT-TEXT", "ATTACHED-FILE-TEXT", "SOMEONE-ELSES-WORDS"]) {
            expect(promptSent()).not.toContain(hidden);
        }

        expect(JSON.stringify(generateText.mock.calls[0]![0].system)).not.toContain("ASSISTANT-REPLY-TEXT");
    });

    it("leaves out chats a job or another person wrote in: task, trigger, eval, sub-agent, messenger, host, bot and untagged threads", async () => {
        await settings();

        const origins: Record<string, unknown>[] = [
            { tags: ["task"] },
            { tags: ["trigger"] },
            { tags: ["eval"] },
            { tags: ["sub-agent"] },
            { tags: ["sub-agent", "worker"] },
            { tags: ["chat", "host"] },
            { tags: ["chat", "local"] },
            { tags: ["chat", "develop"] },
            { source: "telegram", tags: ["telegram"] },
            { externalThreadId: "ext-1" },
            { messengerConnectionId: "conn-1" },
            { botId: "bot-1", tags: ["chat"] },
            // A server-made thread with no tag at all (a prompt-optimiser run, a headless caller that names none).
            { tags: undefined },
        ];

        for (const [index, fields] of origins.entries()) {
            await row(await thread(fields), "user", `from another origin ${index}`);
        }

        // Only the composer's own chat is the person's.
        await row(await thread({ tags: ["chat"] }), "user", "typed in a composer chat");

        await run();

        expect(promptSent()).toContain("typed in a composer chat");
        expect(promptSent()).not.toContain("from another origin");
    });

    it("leaves out temporary, locked, deleted and host-run chats, and messages older than a week", async () => {
        await settings();

        for (const [index, fields] of [
            { isTemporary: true },
            { lockedAt: Date.now() },
            { deleted: true },
            { runner: "host" },
            { statelessMode: true },
        ].entries()) {
            await row(await thread(fields), "user", `excluded chat ${index}`);
        }

        const open = await thread();

        await row(open, "user", "kept message");
        await row(open, "user", "old message", { createdAt: Date.now() - SCHEDULE_IDEAS_WINDOW_MS - DAY });

        await run();

        expect(promptSent()).toContain("kept message");
        expect(promptSent()).not.toContain("old message");
        expect(promptSent()).not.toContain("excluded chat");
    });

    it("leaves out a message with a privacy marker or a secret, before it is cut to length", async () => {
        await settings();
        const threadId = await thread();

        await row(threadId, "user", "keep this one");
        await row(threadId, "user", "[private] my plans for friday");
        await row(threadId, "user", `${"x".repeat(MAX_IDEA_MESSAGE_CHARS - 10)} Authorization: Bearer ${KEY}`);

        await run();

        expect(promptSent()).toContain("keep this one");
        expect(promptSent()).not.toContain("my plans for friday");
        expect(promptSent()).not.toContain("abcdefghijklmnop");
        expect(promptSent()).not.toContain("xxxxxxxx");
    });

    it("is bounded by message count, by characters per message and by characters in all", async () => {
        await settings();
        const threadId = await thread();

        for (let index = 0; index < IDEA_ROWS_READ_PER_THREAD; index += 1) {
            await row(threadId, "user", `message ${index} ${"y".repeat(MAX_IDEA_MESSAGE_CHARS * 2)}`);
        }

        await run();

        const lines = promptSent()
            .split("\n")
            .filter((line) => NUMBERED_LINE.test(line));

        expect(lines.length).toBeLessThanOrEqual(MAX_IDEA_SOURCE_MESSAGES);
        expect(lines.length).toBeLessThan(IDEA_ROWS_READ_PER_THREAD);
        expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(MAX_IDEA_MESSAGE_CHARS + 8);
        expect(lines.join("").length).toBeLessThanOrEqual(MAX_IDEA_SOURCE_CHARS + lines.length * 6);
    });

    it("never reads more than the message cap across chats", () => {
        const candidates = Array.from({ length: MAX_IDEA_SOURCE_MESSAGES * 3 }, (_, index) => {
            return { text: `m${index}`, threadId: "t" };
        });

        expect(takeIdeaSources(candidates)).toHaveLength(MAX_IDEA_SOURCE_MESSAGES);
    });
});

describe("the day", () => {
    it("is taken once: a second run, or a redelivery, makes no second model call", async () => {
        await settings();
        await row(await thread(), "user", "remind me to water the plants every morning");

        await run();
        await run();

        expect(generateText).toHaveBeenCalledOnce();
        expect(await suggestions()).toHaveLength(1);
        const again = await prepare();

        expect(again.messages).toEqual([]);
    });

    it("is taken per user", async () => {
        await settings();
        await settings({}, OTHER);
        await row(await thread(), "user", "first user's message");
        await row(await thread({}, OTHER), "user", "second user's message", { userId: OTHER });

        await run();
        await run(OTHER);

        expect(generateText).toHaveBeenCalledTimes(2);
    });

    it("is not queued again by the sweep once the job has taken it", async () => {
        await settings();
        await row(await thread(), "user", "a message");

        await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]!.args).toEqual({ userId: USER });
        expect(enqueued[0]!.options).toMatchObject({ once: { jobId: `schedule-ideas:${scheduleIdeasDayKey(USER, Date.now())}`, userId: USER } });

        await run();
        await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        expect(enqueued).toHaveLength(1);
    });
});

describe("who is skipped", () => {
    it("a user with the switch off, or who never set it", async () => {
        await settings({ scheduleIdeasEnabled: false });
        await row(await thread(), "user", "a message");

        await run();
        await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        expect(generateText).not.toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);
        expect(await suggestions()).toHaveLength(0);

        await harness.run(async (ctx: any) => {
            const [existing] = await ctx.db.query("userSettings").collect();

            await ctx.db.delete("userSettings", existing._id);
        });
        await run();

        expect(generateText).not.toHaveBeenCalled();
    });

    it("a user with memory off, without taking the day", async () => {
        await settings({ memoryEnabled: false });
        await row(await thread(), "user", "a message");

        await run();
        await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        expect(generateText).not.toHaveBeenCalled();
        expect(enqueued).toHaveLength(0);

        await harness.run(async (ctx: any) => {
            const [existing] = await ctx.db.query("userSettings").collect();

            await ctx.db.patch("userSettings", existing._id, { memoryEnabled: true });
        });
        await run();

        expect(generateText).toHaveBeenCalledOnce();
    });

    it("a user whose rules allow no utility model: nothing is sent or stored, and the job does not throw", async () => {
        getUtilityModel.mockRejectedValue(Object.assign(new Error("No background model is allowed"), { code: "no-allowed-utility-model" }));
        await settings();
        await row(await thread(), "user", "a message");

        await expect(run()).resolves.toBeNull();

        expect(generateText).not.toHaveBeenCalled();
        expect(await suggestions()).toHaveLength(0);
    });

    it("a user with nothing typed in the last week: no model call", async () => {
        await settings();
        await row(await thread(), "assistant", "only an assistant reply");

        await run();

        expect(generateText).not.toHaveBeenCalled();
    });

    it("a failed model call stores nothing and leaves the day taken", async () => {
        generateText.mockRejectedValue(new Error("gateway down"));
        await settings();
        await row(await thread(), "user", "a message");

        await expect(run()).resolves.toBeNull();
        await run();

        expect(generateText).toHaveBeenCalledOnce();
        expect(await suggestions()).toHaveLength(0);
    });
});

describe("what is stored", () => {
    it("goes through the validating insert: a secret, a bad schedule and an empty title are dropped", async () => {
        generateText.mockResolvedValue({
            output: {
                ideas: [
                    idea({ title: "Good idea" }),
                    idea({ instructions: `Call the API with Authorization: Bearer ${KEY}`, title: "Leaky" }),
                    idea({ cronExpression: "not a cron", title: "Bad schedule" }),
                ],
            },
        });
        await settings();
        await row(await thread(), "user", "a message");

        await run();

        const stored = await suggestions();

        expect(stored.map((suggestion) => suggestion.title)).toEqual(["Good idea"]);
    });

    it("takes at most the proposal cap even when the model returns more, and names the chats of the messages an idea came from", async () => {
        const first = await thread();
        const second = await thread();

        await settings();
        await row(first, "user", "message in the first chat");
        await row(second, "user", "message in the second chat");
        generateText.mockResolvedValue({
            output: { ideas: Array.from({ length: MAX_IDEA_PROPOSALS + 2 }, (_, index) => idea({ sources: [1, 2, 99, 1.5], title: `Idea ${index}` })) },
        });

        await run();

        const stored = await suggestions();

        expect(stored).toHaveLength(MAX_IDEA_PROPOSALS);
        expect(new Set(stored[0].sourceThreadIds)).toEqual(new Set([first, second]));
        expect(JSON.stringify(stored)).not.toContain("message in the first chat");
    });

    it("never creates a task", async () => {
        await settings();
        await row(await thread(), "user", "a message");

        await run();

        expect(await harness.run(async (ctx: any) => await ctx.db.query("tasks").collect())).toHaveLength(0);
    });

    it("an idea naming no valid message keeps no source chat", () => {
        expect(toSuggestions([idea({ sources: [0, 7] })], [{ text: "a", threadId: "t" }])[0]!.sourceThreadIds).toEqual([]);
    });
});

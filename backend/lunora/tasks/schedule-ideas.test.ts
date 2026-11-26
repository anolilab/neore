/**
 * The daily schedule-ideas job against the real schema: what the model is sent (the person's typed words, nothing
 * else, and bounded), that a day is taken once, who is skipped, and that every proposal goes through the validating
 * insert. The model, the gateway and the jobs queue are mocked; what they receive is the assertion.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { claimKey, completeKey, JOB_CLAIM_TTL_MS, releaseKey } from "../lib/claim-once";
import { runJobOnce } from "../lib/job-once";
import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import {
    IDEA_ROWS_READ_PER_THREAD,
    IDEA_THREADS_SCANNED,
    isScheduleIdeasDay,
    MAX_IDEA_MESSAGE_CHARS,
    MAX_IDEA_PROPOSALS,
    MAX_IDEA_SOURCE_CHARS,
    MAX_IDEA_SOURCE_MESSAGES,
    MAX_IDEA_SOURCE_THREADS,
    scheduleIdeasDay,
    scheduleIdeasDayKey,
    SCHEDULE_IDEAS_WINDOW_MS,
    takeIdeaSources,
    toSuggestions,
} from "./schedule-ideas-logic";
import { dispatchScheduleIdeas, generateScheduleIdeas, prepareScheduleIdeas } from "./schedule-ideas";

const { enqueued, failSettingsRead, generateText, getUtilityModel, registry } = vi.hoisted(() => {
    return {
        enqueued: [] as { args: unknown; options: unknown }[],
        failSettingsRead: { on: false },
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
// Lets one test make the preparation mutation fail, the way a storage error would.
vi.mock("../memory/functions", async (importOriginal) => {
    const original = await importOriginal<typeof import("../memory/functions")>();

    return {
        ...original,
        readMemoryEnabled: async (...args: Parameters<typeof original.readMemoryEnabled>) => {
            if (failSettingsRead.on) {
                throw new Error("storage unavailable");
            }

            return await original.readMemoryEnabled(...args);
        },
    };
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

const row = async (threadId: string, role: "assistant" | "user", text: string, fields: Record<string, unknown> = {}): Promise<string> => {
    order += 1;

    return await harness.run(
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

/**
 * The instant every test runs at: midday UTC, so neither the sweep's `ctx.now` nor the day a test works out for its
 * assertions can fall on the other side of midnight. The harness reads `ctx.now` from `Date.now()`, so faking `Date` moves both.
 */
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

const today = (): string => scheduleIdeasDay(Date.now());

const run = async (userId = USER, day = today()) => await harness.action(async (ctx: any) => await ctx.runAction(generateScheduleIdeas, { day, userId }));

const prepare = async (userId = USER, day = today()) => await harness.run(async (ctx: any) => await ctx.runMutation(prepareScheduleIdeas, { day, userId }));

/**
 * Delivers the job the way the queue does: through `runJobOnce`, which claims the `jobId`, adds it to the target's
 * arguments and completes or releases the claim. The target is the REAL registered action, input validation included.
 */
const deliver = async (jobId: string, userId = USER, day = today()) =>
    await harness.action(async (ctx: any) => {
        const wrapped = {
            runAction: async (reference: { __lunoraRef: string }, args: unknown) => await ctx.runAction(registry.get(reference.__lunoraRef) as never, args),
            runMutation: async (reference: { __lunoraRef: string }, args: unknown) => {
                const registered = { claimKey, completeKey, releaseKey }[reference.__lunoraRef.split(":", 2)[1] as "claimKey"];

                return await harness.run(async (inner: any) => await inner.runMutation(registered, args));
            },
        };

        return await (runJobOnce as unknown as { handler: (context: unknown, args: unknown) => Promise<unknown> }).handler(wrapped, {
            args: { day, userId },
            jobId,
            target: "tasks_schedule_ideas:generateScheduleIdeas",
            userId,
        });
    });

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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    harness = lunoraTest(schema as never);
    order = 0;
    enqueued.length = 0;
    getUtilityModel.mockResolvedValue({});
    generateText.mockResolvedValue({ output: { ideas: [idea()] } });
});

afterEach(() => {
    failSettingsRead.on = false;
    vi.useRealTimers();
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

    it("leaves out temporary, locked, deleted, being-deleted and host-run chats, and messages older than a week", async () => {
        await settings();

        for (const [index, fields] of [
            { isTemporary: true },
            { lockedAt: Date.now() },
            { deleted: true },
            // Hard deletion in progress: the thread row is still there while its message rows are removed page by page.
            { deletingAt: Date.now() },
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

    it("still reads the person's chats when newer run threads outnumber the chat cap", async () => {
        await settings();

        // A trigger opens a thread per run: more of them, and newer, than the cap on chats read.
        for (let index = 0; index < MAX_IDEA_SOURCE_THREADS + 10; index += 1) {
            await row(await thread({ tags: ["trigger"], updatedAt: Date.now() + index + 1 }), "user", `trigger prompt ${index}`);
        }

        for (let index = 0; index < 5; index += 1) {
            await row(await thread({ updatedAt: Date.now() - 1000 - index }), "user", `typed by hand ${index}`);
        }

        await run();

        expect(generateText).toHaveBeenCalledOnce();
        expect(promptSent()).toContain("typed by hand 0");
        expect(promptSent()).toContain("typed by hand 4");
        expect(promptSent()).not.toContain("trigger prompt");
    });

    it("drops a whole turn whose quote or attachment carries a privacy marker, though its typed words do not", async () => {
        await settings();
        const threadId = await thread();

        await row(threadId, "user", "keep this plain message");
        // The full text holds a quoted line with the marker; the typed words alone are plain.
        await row(threadId, "user", "> [private] quoted line\nTYPED-AFTER-QUOTE", { typedText: "TYPED-AFTER-QUOTE" });
        // The marker sits only in an attachment's text part of the stored content.
        await row(threadId, "user", "TYPED-NEXT-TO-ATTACHMENT", {
            message: {
                content: [
                    { text: "TYPED-NEXT-TO-ATTACHMENT", type: "text" },
                    { text: "notes 🔒 for me", type: "text" },
                ],
                role: "user",
            },
            text: "TYPED-NEXT-TO-ATTACHMENT",
        });

        await run();

        expect(promptSent()).toContain("keep this plain message");
        expect(promptSent()).not.toContain("TYPED-AFTER-QUOTE");
        expect(promptSent()).not.toContain("TYPED-NEXT-TO-ATTACHMENT");
    });

    it("reads a branched chat along its active path: a prompt edited away is not sent, a never-branched chat is read in full", async () => {
        await settings();
        const branched = await thread();

        await row(branched, "user", "KEPT-FIRST-PROMPT");

        const reply = await row(branched, "assistant", "first reply");

        // The second prompt was edited: the original stays in storage as a hidden sibling under the same reply.
        await row(branched, "user", "EDITED-AWAY-PROMPT", { parentMessageId: reply });

        const edited = await row(branched, "user", "KEPT-EDITED-PROMPT", { parentMessageId: reply });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", branched, { activeLeafMessageId: edited }));

        const linear = await thread();

        await row(linear, "user", "NEVER-BRANCHED-PROMPT");

        await run();

        expect(generateText).toHaveBeenCalledOnce();

        for (const shown of ["KEPT-FIRST-PROMPT", "KEPT-EDITED-PROMPT", "NEVER-BRANCHED-PROMPT"]) {
            expect(promptSent()).toContain(shown);
        }

        expect(promptSent()).not.toContain("EDITED-AWAY-PROMPT");
    });

    it("counts only messages it can send toward the cap, so chats full of secrets do not hide a clean one", async () => {
        await settings();

        // Two newer chats of secret-bearing messages would fill the 50-message cap if they were counted; the clean chat is older.
        for (const [index, age] of [1, 2].entries()) {
            const secretChat = await thread({ updatedAt: NOW - age });

            for (let message = 0; message < IDEA_ROWS_READ_PER_THREAD; message += 1) {
                await row(secretChat, "user", `${KEY} chat ${index} message ${message}`);
            }
        }

        await row(await thread({ updatedAt: NOW - 3 }), "user", "CLEAN-MESSAGE-IN-THE-THIRD-CHAT");

        await run();

        expect(generateText).toHaveBeenCalledOnce();
        expect(promptSent()).toContain("CLEAN-MESSAGE-IN-THE-THIRD-CHAT");
        expect(promptSent()).not.toContain(KEY);
    });

    it("looks at no more than the scan bound of recent chats", async () => {
        await settings();
        await row(await thread({ updatedAt: Date.now() - 5000 }), "user", "too far back to be found");

        for (let index = 0; index < IDEA_THREADS_SCANNED; index += 1) {
            await thread({ tags: ["task"], updatedAt: Date.now() + index + 1 });
        }

        await run();

        expect(generateText).not.toHaveBeenCalled();
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

describe("the queued job", () => {
    it("declares the jobId the once wrapper adds to its target's arguments, as optional", () => {
        // The runtime refuses an argument the action does not declare, and the harness does not: the declaration is checked itself.
        const input = (generateScheduleIdeas as unknown as { args: Record<string, { isOptional?: boolean; kind: string }> }).args;

        expect(Object.keys(input).toSorted((a, b) => a.localeCompare(b))).toEqual(["day", "jobId", "userId"]);
        expect(input.userId!.kind).not.toBe("optional");
        expect(input.jobId!.kind).toBe("optional");
    });

    it("runs when delivered through the once wrapper, which adds its jobId to the arguments", async () => {
        await settings();
        await row(await thread(), "user", "remind me to water the plants every morning");

        await deliver("schedule-ideas:job-1");

        expect(generateText).toHaveBeenCalledOnce();
        expect(await suggestions()).toHaveLength(1);
    });

    it("does not spend the day when a switch is off at delivery: turned on again the same day, the same job runs", async () => {
        await settings({ scheduleIdeasEnabled: false });
        await row(await thread(), "user", "remind me to water the plants every morning");

        await deliver("schedule-ideas:job-1");

        expect(generateText).not.toHaveBeenCalled();

        await harness.run(async (ctx: any) => {
            const [existing] = await ctx.db.query("userSettings").collect();

            await ctx.db.patch("userSettings", existing._id, { scheduleIdeasEnabled: true });
        });
        // The sweep sends the same job id for the day; its claim was given back, so the delivery is not suppressed.
        await deliver("schedule-ideas:job-1");

        expect(generateText).toHaveBeenCalledOnce();
        expect(await suggestions()).toHaveLength(1);

        // A redelivery after the real run is still refused.
        await deliver("schedule-ideas:job-1");

        expect(generateText).toHaveBeenCalledOnce();
    });

    it("stops before the model call when a switch is turned off after the messages were read, and keeps the day for a later run", async () => {
        await settings();
        await row(await thread(), "user", "remind me to water the plants every morning");
        // Choosing the model takes time; the person turns the feature off meanwhile.
        getUtilityModel.mockImplementation(async () => {
            await harness.run(async (ctx: any) => {
                const [existing] = await ctx.db.query("userSettings").collect();

                await ctx.db.patch("userSettings", existing._id, { scheduleIdeasEnabled: false });
            });

            return {};
        });

        await run();

        expect(generateText).not.toHaveBeenCalled();
        expect(await suggestions()).toHaveLength(0);

        getUtilityModel.mockResolvedValue({});
        await harness.run(async (ctx: any) => {
            const [existing] = await ctx.db.query("userSettings").collect();

            await ctx.db.patch("userSettings", existing._id, { scheduleIdeasEnabled: true });
        });
        await run();

        expect(generateText).toHaveBeenCalledOnce();
    });

    it("stops before the model call when memory is turned off after the messages were read", async () => {
        await settings();
        await row(await thread(), "user", "a message");
        getUtilityModel.mockImplementation(async () => {
            await harness.run(async (ctx: any) => {
                const [existing] = await ctx.db.query("userSettings").collect();

                await ctx.db.patch("userSettings", existing._id, { memoryEnabled: false });
            });

            return {};
        });

        await run();

        expect(generateText).not.toHaveBeenCalled();
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

    it("is queued once by repeated sweep passes before the job is delivered", async () => {
        await settings();

        for (let pass = 0; pass < 3; pass += 1) {
            await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));
        }

        expect(enqueued).toHaveLength(1);
    });

    it("is queued again after a skipped delivery once the switch is back on, and after a refused send", async () => {
        const sweep = async () => await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        await settings();
        await row(await thread(), "user", "a message");
        await sweep();
        expect(enqueued).toHaveLength(1);

        // The switch goes off before the job is delivered: the delivery is skipped and the day's queued mark is given back.
        await harness.run(async (ctx: any) => {
            const [existing] = await ctx.db.query("userSettings").collect();

            await ctx.db.patch("userSettings", existing._id, { scheduleIdeasEnabled: false });
        });
        await deliver("schedule-ideas:job-1");
        await harness.run(async (ctx: any) => {
            const [existing] = await ctx.db.query("userSettings").collect();

            await ctx.db.patch("userSettings", existing._id, { scheduleIdeasEnabled: true });
        });
        await sweep();

        expect(enqueued).toHaveLength(2);
        expect(generateText).not.toHaveBeenCalled();
    });

    it("is not queued again by the sweep once the job has taken it", async () => {
        await settings();
        await row(await thread(), "user", "a message");

        await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]!.args).toEqual({ day: today(), userId: USER });
        expect(enqueued[0]!.options).toMatchObject({ once: { jobId: `schedule-ideas:${scheduleIdeasDayKey(USER, Date.now())}`, userId: USER } });

        await run();
        await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        expect(enqueued).toHaveLength(1);
    });
});

describe("a source chat locked while the model is being chosen", () => {
    const lockMeanwhile = (threadId: string, fields: Record<string, unknown>) =>
        getUtilityModel.mockImplementation(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, fields));

            return {};
        });

    it("is not sent, while a chat still readable is", async () => {
        await settings();
        const locked = await thread();
        const open = await thread();

        await row(locked, "user", "WORDS-OF-THE-LOCKED-CHAT");
        await row(open, "user", "words of the open chat");
        lockMeanwhile(locked, { lockedAt: Date.now() });

        await run();

        expect(generateText).toHaveBeenCalledOnce();
        expect(promptSent()).toContain("words of the open chat");
        expect(promptSent()).not.toContain("WORDS-OF-THE-LOCKED-CHAT");
    });

    it("makes no model call when it was the only source, whether it was locked or deleted", async () => {
        for (const fields of [{ lockedAt: Date.now() }, { deleted: true }, { deletingAt: Date.now() }]) {
            generateText.mockClear();
            harness = lunoraTest(schema as never);
            await settings();
            const only = await thread();

            await row(only, "user", "words of the only chat");
            lockMeanwhile(only, fields);

            await run();

            expect(generateText).not.toHaveBeenCalled();
            expect(await suggestions()).toHaveLength(0);
        }
    });
});

describe("the day a job was queued for", () => {
    it("is the day it claims when it is delivered after midnight, leaving the next day free", async () => {
        await settings();
        await row(await thread(), "user", "remind me to water the plants every morning");
        // Queued at 12:00 UTC the day before; delivered now, a day later (`ctx.now` is `NOW`).
        const queuedFor = scheduleIdeasDay(NOW - DAY);

        expect(queuedFor).not.toBe(today());
        await deliver(`schedule-ideas:${USER}:${queuedFor}`, USER, queuedFor);

        expect(generateText).toHaveBeenCalledOnce();

        const claims = await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect());
        const taken = claims.filter((claim: any) => claim.scope === "schedule-ideas").map((claim: any) => claim.key);

        expect(taken).toEqual([`${USER}:${queuedFor}`]);

        // The sweep of the day the job was delivered on still queues its own job.
        await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));

        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]!.args).toEqual({ day: today(), userId: USER });
    });

    it("refuses a day that is not a calendar day, without calling the model or taking a day", async () => {
        await settings();
        await row(await thread(), "user", "a message");

        await expect(run(USER, "not-a-day")).resolves.toBeNull();

        expect(generateText).not.toHaveBeenCalled();
        const afterwards = await prepare();

        expect(afterwards.messages).toHaveLength(1);
    });

    it("refuses a day that has the shape of a date but is not one, without throwing", async () => {
        await settings();
        await row(await thread(), "user", "a message");

        for (const day of ["2026-13-01", "2026-00-10", "2026-02-30", "2026-04-31", "2026-01-32"]) {
            expect(isScheduleIdeasDay(day)).toBe(false);
            await expect(run(USER, day)).resolves.toBeNull();
        }

        expect(isScheduleIdeasDay("2026-02-28")).toBe(true);
        expect(generateText).not.toHaveBeenCalled();
    });
});

describe("a failed preparation", () => {
    it("is handled like any other failure: the action answers null, sends nothing and does not throw", async () => {
        await settings();
        await row(await thread(), "user", "every monday I need a summary of my notes");
        failSettingsRead.on = true;

        await expect(run()).resolves.toBeNull();

        expect(generateText).not.toHaveBeenCalled();

        // The failed mutation rolled back, so the day's own claim was not taken. (Delivered through `runJobOnce`, a `null`
        // answer still completes the job claim, as for a failed model call: this calls the action directly.)
        failSettingsRead.on = false;
        await expect(run()).resolves.toBeNull();

        expect(generateText).toHaveBeenCalledOnce();
    });
});

describe("a skipped delivery", () => {
    const sweep = async () => await runInShard(USER, async () => await harness.run(async (ctx: any) => await ctx.runMutation(dispatchScheduleIdeas, {})));
    const setSwitch = async (on: boolean) =>
        await harness.run(async (ctx: any) => {
            const [existing] = await ctx.db.query("userSettings").collect();

            await ctx.db.patch("userSettings", existing._id, { scheduleIdeasEnabled: on });
        });

    it("does not let a sweep queue a replacement while its job claim is still held, and exactly one job runs once it is back", async () => {
        const jobId = `schedule-ideas:${scheduleIdeasDayKey(USER, Date.now())}`;

        await settings({ scheduleIdeasEnabled: false });
        await row(await thread(), "user", "remind me to water the plants every morning");
        // The sweep queued the day's job while the switch was on.
        await setSwitch(true);
        await sweep();
        expect(enqueued).toHaveLength(1);
        await setSwitch(false);

        // The delivery holds the job claim, as `runJobOnce` does until its target has returned.
        await harness.run(
            async (ctx: any) => await ctx.runMutation(claimKey, { key: jobId, leaseMs: 1000, scope: "job", ttlMs: JOB_CLAIM_TTL_MS, userId: USER }),
        );
        await expect(run()).resolves.toEqual({ skipped: true });
        await setSwitch(true);

        // A sweep between the skip and the claim's release must send nothing: it would be dropped, and its mark would strand the day.
        await sweep();
        expect(enqueued).toHaveLength(1);

        await harness.run(async (ctx: any) => await ctx.runMutation(releaseKey, { key: jobId, scope: "job" }));
        await sweep();
        await sweep();
        expect(enqueued).toHaveLength(2);

        await deliver(jobId);
        await deliver(jobId);
        await sweep();

        expect(generateText).toHaveBeenCalledOnce();
        expect(enqueued).toHaveLength(2);
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

/**
 * Idle-thread summaries against the real schema: which path a summary serves,
 * which threads get one, the debounce, redelivery, and what the agent reads.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { deleteAllForThreadIdAsync } from "./threads";
import { getThreadSummaryForContext, runThreadSummary } from "./thread-summaries";
import { SUMMARIES_KEPT_PER_THREAD, SUMMARY_MAX_CHARS } from "./thread-summary-logic";

const { generateText, registry } = vi.hoisted(() => {
    return { generateText: vi.fn(), registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
    };
});
// The harness action ctx has no `services`.
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});

const OWNER = "owner-user";
/** Past the window (100) plus the margin (20). */
const ROWS = 130;

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
let rowIds: string[];

const insertRow = async (index: number, extra: Record<string, unknown> = {}): Promise<string> => {
    const role = index % 2 === 0 ? "user" : "assistant";

    return await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: { content: `turn ${index}`, role },
                order: Math.floor(index / 2),
                status: "success",
                stepOrder: index % 2,
                text: `turn ${index}`,
                threadId,
                tool: false,
                userId: OWNER,
                ...extra,
            }),
    );
};

const seedThread = async (rows: number, thread: Record<string, unknown> = {}) => {
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "regular", title: "Long", userId: OWNER, ...thread }));
    rowIds = [];

    for (let index = 0; index < rows; index += 1) {
        rowIds.push(await insertRow(index));
    }
};

const runJob = async (afterMessageId: string) => await harness.action(async (ctx: any) => await ctx.runAction(runThreadSummary, { afterMessageId, threadId }));

const summaries = async (): Promise<{ coveredUpToMessageId: string; summary: string }[]> =>
    await harness.run(async (ctx: any) => await ctx.db.query("threadContextSummaries").collect());

const contextSummary = async (promptMessageId?: string) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(getThreadSummaryForContext, { promptMessageId, threadId }));

const storeSummary = async (coveredIndex: number, summary: string, coveredCount = coveredIndex + 1) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("threadContextSummaries", {
                coveredCount,
                coveredUpToMessageId: rowIds[coveredIndex],
                createdAt: Date.now(),
                summary,
                threadId,
                userId: OWNER,
            }),
    );

beforeAll(async () => {
    registerModule(registry, "agent_thread_summaries", await import("./thread-summaries"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    generateText.mockResolvedValue({ text: "The user is planning a trip.", usage: { inputTokens: 10, outputTokens: 5 } });
});

afterEach(() => {
    harness.close();
    generateText.mockReset();
});

describe("making a summary", () => {
    it("summarises the rows falling out of the window once the thread has been idle, and stores one row", async () => {
        expect.assertions(5);

        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        const stored = await summaries();

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.summary).toBe("The user is planning a trip.");
        // 130 rows, a 100-row window and a 20-row overlap: the cover ends 50 rows from the top.
        expect(stored[0]?.coveredUpToMessageId).toBe(rowIds[49]);
        // The older rows go to the model as evidence, the newest ones do not.
        expect(generateText.mock.calls[0]?.[0].prompt).not.toContain("turn 120");
    });

    it("caps the stored summary", async () => {
        expect.assertions(1);

        generateText.mockResolvedValue({ text: "z".repeat(SUMMARY_MAX_CHARS * 2), usage: {} });
        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        const [stored] = await summaries();

        expect(stored?.summary).toHaveLength(SUMMARY_MAX_CHARS);
    });

    it("does nothing for a thread that is not long enough", async () => {
        expect.assertions(2);

        await seedThread(100);
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();
        expect(await summaries()).toHaveLength(0);
    });

    it.each([
        ["temporary", { isTemporary: true }],
        ["locked", { lockedAt: 1 }],
        ["deleted", { deleted: true }],
        ["stateless", { statelessMode: true }],
    ])("makes none for a %s thread", async (_name, thread) => {
        expect.assertions(2);

        await seedThread(ROWS, thread);
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();
        expect(await summaries()).toHaveLength(0);
    });

    it("makes none when the owner turned summaries off, and makes one when the setting is absent or on", async () => {
        expect.assertions(3);

        await seedThread(ROWS);
        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { threadSummariesEnabled: false, userId: OWNER }));
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();

        await harness.run(async (ctx: any) => {
            const row = await ctx.db.query("userSettings").first();

            await ctx.db.patch(row._id, { threadSummariesEnabled: true });
        });
        await runJob(rowIds.at(-1)!);

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await summaries()).toHaveLength(1);
    });

    it("stores nothing, and frees the cut, when the model call fails", async () => {
        expect.assertions(3);

        generateText.mockRejectedValueOnce(new Error("gateway down"));
        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        expect(await summaries()).toHaveLength(0);

        // The next job may try the same cut again.
        await runJob(rowIds.at(-1)!);

        expect(generateText).toHaveBeenCalledTimes(2);
        expect(await summaries()).toHaveLength(1);
    });

    it("extends the summary on its own path from where it ended, replacing the row", async () => {
        expect.assertions(4);

        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        for (let index = ROWS; index < ROWS + 30; index += 1) {
            rowIds.push(await insertRow(index));
        }

        generateText.mockResolvedValue({ text: "Updated summary.", usage: {} });
        await runJob(rowIds.at(-1)!);

        const stored = await summaries();

        expect(stored).toHaveLength(1);
        expect(stored[0]?.summary).toBe("Updated summary.");
        expect(stored[0]?.coveredUpToMessageId).toBe(rowIds[79]);
        // The previous summary and only the rows after its cover go to the model.
        const { prompt } = generateText.mock.calls[1]![0];

        expect(prompt).toContain("The user is planning a trip.");
    });

    it("keeps the newest few summaries of other branches next to the new one", async () => {
        expect.assertions(2);

        await seedThread(ROWS);

        // Summaries whose covered row is not on this path (another thread's row stands in for a dead branch).
        const stray = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: "x", role: "user" },
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    text: "x",
                    threadId: await ctx.db.insert("threads", { status: "regular", userId: OWNER }),
                    tool: false,
                    userId: OWNER,
                }),
        );

        for (let index = 0; index < SUMMARIES_KEPT_PER_THREAD; index += 1) {
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("threadContextSummaries", {
                        coveredCount: 5,
                        coveredUpToMessageId: stray,
                        createdAt: 1000 + index,
                        summary: `other ${index}`,
                        threadId,
                        userId: OWNER,
                    }),
            );
        }

        await runJob(rowIds.at(-1)!);

        const stored = await summaries();

        expect(stored).toHaveLength(SUMMARIES_KEPT_PER_THREAD);
        // The oldest of the other branches' rows went; the new one is there.
        expect(stored.map((row) => row.summary).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["other 1", "other 2", "The user is planning a trip."]);
    });
});

describe("the debounce and redelivery", () => {
    it("runs one job for two replies: the earlier job finds a newer row", async () => {
        expect.assertions(3);

        await seedThread(ROWS);

        const firstReplyRow = rowIds.at(-1)!;

        // A second reply lands before the first job fires.
        rowIds.push(await insertRow(ROWS), await insertRow(ROWS + 1));

        await runJob(firstReplyRow);

        expect(generateText).not.toHaveBeenCalled();

        await runJob(rowIds.at(-1)!);

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await summaries()).toHaveLength(1);
    });

    it("does not run while a reply is still streaming", async () => {
        expect.assertions(2);

        await seedThread(ROWS);
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: rowIds.at(-1),
                    status: "streaming",
                    threadId,
                    userId: OWNER,
                }),
        );
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();
        expect(await summaries()).toHaveLength(0);
    });

    it("does the work once when the same job is delivered twice, even at the same moment", async () => {
        expect.assertions(2);

        await seedThread(ROWS);
        await Promise.all([runJob(rowIds.at(-1)!), runJob(rowIds.at(-1)!)]);
        await runJob(rowIds.at(-1)!);

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await summaries()).toHaveLength(1);
    });
});

describe("erasure", () => {
    it("goes with the thread", async () => {
        expect.assertions(2);

        await seedThread(10);
        await storeSummary(4, "Early turns.");

        expect(await summaries()).toHaveLength(1);

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForThreadIdAsync, { threadId }));

        expect(await summaries()).toHaveLength(0);
    });
});

describe("what the agent reads", () => {
    it("returns the summary for a prompt on its own path", async () => {
        expect.assertions(1);

        await seedThread(ROWS);
        await storeSummary(49, "Early turns: trip planning.");

        expect(await contextSummary(rowIds.at(-1))).toBe("Early turns: trip planning.");
    });

    it("returns it for a prompt that is not saved yet, from the thread's latest row", async () => {
        expect.assertions(1);

        await seedThread(ROWS);
        await storeSummary(49, "Early turns: trip planning.");

        expect(await contextSummary()).toBe("Early turns: trip planning.");
    });

    it("does not use it on a branch that left the path before the covered row", async () => {
        expect.assertions(3);

        await seedThread(ROWS);
        await storeSummary(49, "Early turns: trip planning.");

        // An edit of turn 10's prompt: a sibling of rows[21], parented on rows[20].
        const sibling = await insertRow(21, { parentMessageId: rowIds[20] });

        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: sibling }));

        expect(await contextSummary(sibling)).toBeNull();
        // Switching back to the original path uses it again.
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: rowIds.at(-1) }));

        expect(await contextSummary(rowIds.at(-1))).toBe("Early turns: trip planning.");
        // And the branch that leaves AFTER the covered row still has it.
        const late = await insertRow(121, { parentMessageId: rowIds[120] });

        expect(await contextSummary(late)).toBe("Early turns: trip planning.");
    });

    it("prefers the summary covering more of the path, and ignores one whose covered row is gone", async () => {
        expect.assertions(2);

        await seedThread(ROWS);
        await storeSummary(29, "shorter");
        await storeSummary(49, "longer");

        expect(await contextSummary(rowIds.at(-1))).toBe("longer");

        await harness.run(async (ctx: any) => await ctx.db.delete(rowIds[49]));

        expect(await contextSummary(rowIds.at(-1))).toBe("shorter");
    });

    it.each([
        ["locked", { lockedAt: 1 }],
        ["temporary", { isTemporary: true }],
    ])("answers nothing for a %s thread", async (_name, thread) => {
        expect.assertions(1);

        await seedThread(ROWS, thread);
        await storeSummary(49, "Early turns: trip planning.");

        expect(await contextSummary(rowIds.at(-1))).toBeNull();
    });

    it("answers nothing once the owner opted out", async () => {
        expect.assertions(2);

        await seedThread(ROWS);
        await storeSummary(49, "Early turns: trip planning.");

        expect(await contextSummary(rowIds.at(-1))).toBe("Early turns: trip planning.");

        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { threadSummariesEnabled: false, userId: OWNER }));

        expect(await contextSummary(rowIds.at(-1))).toBeNull();
    });
});

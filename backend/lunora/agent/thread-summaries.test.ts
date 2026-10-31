/**
 * Idle-thread summaries against the real schema: which path a summary serves,
 * which threads get one, the debounce, redelivery, and what the agent reads.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { threadSummaryTaint } from "./thread-summary-taint";
import { deleteAllForThreadIdAsync } from "./threads";
import { eraseUserThreadSummaries, getThreadSummaryForContext, runThreadSummary } from "./thread-summaries";
import { SUMMARIES_KEPT_PER_THREAD, SUMMARY_MAX_CHARS } from "./thread-summary-logic";

const { generateText, limits, registry } = vi.hoisted(() => {
    return { generateText: vi.fn(), limits: { maxPathRows: 5000 }, registry: new Map<string, unknown>() };
});

// A small cap lets a test cross it without thousands of rows.
vi.mock("./thread-summary-logic", async (importOriginal) => {
    const original = await importOriginal<typeof import("./thread-summary-logic")>();

    return {
        ...original,
        get SUMMARY_MAX_PATH_ROWS() {
            return limits.maxPathRows;
        },
    };
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
/** Summaries are OPT-IN: a thread's owner has switched them on unless a test says otherwise. */
let optedIn = true;

const optIn = async () => await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { threadSummariesEnabled: true, userId: OWNER }));

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

    if (optedIn) {
        await optIn();
    }

    for (let index = 0; index < rows; index += 1) {
        rowIds.push(await insertRow(index));
    }
};

const runJob = async (afterMessageId: string) => await harness.action(async (ctx: any) => await ctx.runAction(runThreadSummary, { afterMessageId, threadId }));

const summaries = async (): Promise<{ coveredUpToMessageId: string; summary: string; taintedBy: string[] }[]> =>
    await harness.run(async (ctx: any) => await ctx.db.query("threadContextSummaries").collect());

const contextSummary = async (promptMessageId?: string) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(getThreadSummaryForContext, { promptMessageId, threadId }));

const storeSummary = async (coveredIndex: number, summary: string, coveredCount = coveredIndex + 1, taintedBy: string[] = []) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("threadContextSummaries", {
                coveredCount,
                coveredUpToMessageId: rowIds[coveredIndex],
                createdAt: Date.now(),
                summary,
                taintedBy,
                threadId,
                userId: OWNER,
            }),
    );

const threadRow = async () => (await harness.run(async (ctx: any) => await ctx.db.get(threadId))) as { summaryEpoch?: number; summaryPathTooLongAt?: number };

beforeAll(async () => {
    registerModule(registry, "agent_thread_summaries", await import("./thread-summaries"));
});

beforeEach(() => {
    optedIn = true;
    limits.maxPathRows = 5000;
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

    it("makes none until the owner switched summaries on: absent and off both mean off", async () => {
        expect.assertions(4);

        optedIn = false;
        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();

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
        // The previous summary goes to the model with the rows after its cover.
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
                        taintedBy: [],
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

describe("a branch", () => {
    it("summarises a reply regenerated on an earlier turn, though another branch holds later rows", async () => {
        expect.assertions(2);

        await seedThread(ROWS + 10);
        // Back on turn 64, the reply is regenerated: a sibling of rows[129], which the original path went on past.
        // The original path's next turn keeps its parent, as `addMessagesHandler` pins it before a sibling lands.
        await harness.run(async (ctx: any) => await ctx.db.patch(rowIds[130], { parentMessageId: rowIds[129] }));
        const regenerated = await insertRow(129, { parentMessageId: rowIds[128] });

        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: regenerated }));
        await runJob(regenerated);

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(await summaries()).toHaveLength(1);
    });

    it("does nothing for a reply that no longer ends the active path", async () => {
        expect.assertions(1);

        await seedThread(ROWS + 10);
        // The original path's next turn keeps its parent, as `addMessagesHandler` pins it before a sibling lands.
        await harness.run(async (ctx: any) => await ctx.db.patch(rowIds[130], { parentMessageId: rowIds[129] }));
        const regenerated = await insertRow(129, { parentMessageId: rowIds[128] });

        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: regenerated }));
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();
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

    it("ignores a summary whose cover is too far back to sit next to the window", async () => {
        expect.assertions(2);

        await seedThread(400);
        await storeSummary(10, "Rows 0 to 10.");

        expect(await contextSummary(rowIds.at(-1))).toBeNull();

        await storeSummary(250, "Rows 0 to 250.");

        expect(await contextSummary(rowIds.at(-1))).toBe("Rows 0 to 250.");
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

    it("answers nothing unless the owner opted in, and nothing again once they opt out", async () => {
        expect.assertions(3);

        optedIn = false;
        await seedThread(ROWS);
        await storeSummary(49, "Early turns: trip planning.");

        expect(await contextSummary(rowIds.at(-1))).toBeNull();

        await optIn();

        expect(await contextSummary(rowIds.at(-1))).toBe("Early turns: trip planning.");

        await harness.run(async (ctx: any) => {
            const row = await ctx.db.query("userSettings").first();

            await ctx.db.patch(row._id, { threadSummariesEnabled: false });
        });

        expect(await contextSummary(rowIds.at(-1))).toBeNull();
    });
});

/** A tool row: what a web search left in the thread. */
const toolRow = {
    message: { content: [{ output: "x", toolCallId: "c", toolName: "webSearch", type: "tool-result" }], role: "tool" },
    text: undefined,
    tool: true,
};

describe("what a summary carries over from the rows it folds in", () => {
    it("records the taint of the tool rows it folded, and the previous summary's with it", async () => {
        expect.assertions(3);

        await seedThread(0);

        // Rows 0..49 are the first slice; one of them is a web search result.
        for (let index = 0; index < ROWS; index += 1) {
            rowIds.push(await insertRow(index, index === 10 ? toolRow : {}));
        }

        await runJob(rowIds.at(-1)!);

        const [head] = await summaries();

        expect(head?.taintedBy).toStrictEqual(["web"]);

        // The next slice holds no tool row, but the summary it extends still did.
        for (let index = ROWS; index < ROWS + 30; index += 1) {
            rowIds.push(await insertRow(index));
        }

        await runJob(rowIds.at(-1)!);

        const [stored] = await summaries();

        expect(stored?.coveredUpToMessageId).toBe(rowIds[79]);
        expect(stored?.taintedBy).toStrictEqual(["web"]);
    });

    it("keeps a clean summary clean", async () => {
        expect.assertions(1);

        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        const [head] = await summaries();

        expect(head?.taintedBy).toStrictEqual([]);
    });

    it("moves the cover past a first cut with no text, so the next job summarises the rows after it", async () => {
        expect.assertions(5);

        await seedThread(ROWS);
        // The first cut (rows 0..49) is all tool results.
        await harness.run(async (ctx: any) => {
            for (const id of rowIds.slice(0, 50)) {
                await ctx.db.patch(id, { message: toolRow.message, tool: true });
            }
        });
        await runJob(rowIds.at(-1)!);

        const [cover] = await summaries();

        expect(generateText).not.toHaveBeenCalled();
        expect(cover?.coveredUpToMessageId).toBe(rowIds[49]);
        // An empty cover gives the agent nothing to read.
        expect(await contextSummary()).toBeNull();

        for (let index = ROWS; index < ROWS + 30; index += 1) {
            rowIds.push(await insertRow(index));
        }

        await runJob(rowIds.at(-1)!);

        const [next] = await summaries();

        expect(generateText).toHaveBeenCalledTimes(1);
        expect(next?.coveredUpToMessageId).toBe(rowIds[79]);
    });

    it("keeps the taint when the folded rows have no text of their own, which re-stores the old summary", async () => {
        expect.assertions(3);

        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        // Rows 60..89 (the next slice) are all tool results: nothing to summarise, but the cover moves on.
        for (let index = ROWS; index < ROWS + 30; index += 1) {
            rowIds.push(await insertRow(index));
        }

        await harness.run(async (ctx: any) => {
            for (const id of rowIds.slice(50, 80)) {
                await ctx.db.patch(id, { message: toolRow.message, tool: true });
            }
        });
        generateText.mockClear();
        await runJob(rowIds.at(-1)!);

        const [stored] = await summaries();

        expect(generateText).not.toHaveBeenCalled();
        expect(stored?.coveredUpToMessageId).toBe(rowIds[79]);
        expect(stored?.taintedBy).toStrictEqual(["web"]);
    });

    it("reads the taint of the thread's summaries for a device call, whichever branch they belong to", async () => {
        expect.assertions(3);

        await seedThread(ROWS);

        const read = async () => await harness.run(async (ctx: any) => await threadSummaryTaint(ctx, threadId as never));

        expect(await read()).toStrictEqual([]);

        await storeSummary(29, "a", 30, ["mcp"]);
        await storeSummary(49, "b", 50, ["files", "web"]);

        expect(await read()).toStrictEqual(["web", "mcp", "files"]);

        const [first] = await summaries();

        await harness.run(async (ctx: any) => {
            const rows = await ctx.db.query("threadContextSummaries").collect();

            await ctx.db.delete(rows.find((row: any) => row.summary === first?.summary)._id);
        });

        expect(await read()).not.toStrictEqual([]);
    });
});

describe("the cost of a thread too long to read from the top", () => {
    it("exits without walking when the path's turns alone pass the cap, and marks the thread", async () => {
        expect.assertions(4);

        limits.maxPathRows = 50;
        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();
        expect(await summaries()).toHaveLength(0);
        const marked = await threadRow();

        expect(marked.summaryPathTooLongAt).toBeTypeOf("number");

        // The marker is what stops the next job: it makes no call even once the cap would let the path through.
        limits.maxPathRows = 5000;
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();
    });

    it("marks the thread when the walk itself reaches the cap", async () => {
        expect.assertions(2);

        // 130 rows over 65 turns: the turn count (65) is under the cap, the row count is not.
        limits.maxPathRows = 100;
        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        expect(generateText).not.toHaveBeenCalled();
        const marked = await threadRow();

        expect(marked.summaryPathTooLongAt).toBeTypeOf("number");
    });

    it("walks only back to the previous cover when extending", async () => {
        expect.assertions(1);

        await seedThread(ROWS);
        await runJob(rowIds.at(-1)!);

        for (let index = ROWS; index < ROWS + 30; index += 1) {
            rowIds.push(await insertRow(index));
        }

        // 160 rows in all, 110 after the cover: a walk to the top would hit this cap, one that stops at the cover does not.
        limits.maxPathRows = 130;
        await runJob(rowIds.at(-1)!);

        const [head] = await summaries();

        expect(head?.coveredUpToMessageId).toBe(rowIds[79]);
    });
});

describe("a run refused after its model call", () => {
    it("frees its cut, so a job after the user switches summaries back on retries it at once", async () => {
        expect.assertions(3);

        await seedThread(ROWS);
        // The user opts out while the model call runs.
        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => {
                const settings = await ctx.db
                    .query("userSettings")
                    .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
                    .first();

                await ctx.db.patch(settings._id, { threadSummariesEnabled: false });
            });

            return { text: "Made while opting out.", usage: {} };
        });
        await runJob(rowIds.at(-1)!);

        expect(await summaries()).toHaveLength(0);

        await harness.run(async (ctx: any) => {
            const settings = await ctx.db
                .query("userSettings")
                .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
                .first();

            await ctx.db.patch(settings._id, { threadSummariesEnabled: true });
        });
        await runJob(rowIds.at(-1)!);

        expect(generateText).toHaveBeenCalledTimes(2);
        expect(await summaries()).toHaveLength(1);
    });
});

describe("an edit that lands while a summary is being made", () => {
    it("refuses to store a summary prepared before the edit, and lets the next job try again", async () => {
        expect.assertions(4);

        await seedThread(ROWS);
        // The model call takes a while; a reply is edited in place meanwhile.
        generateText.mockImplementationOnce(async () => {
            await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { summaryEpoch: 1 }));

            return { text: "Summary of the old text.", usage: {} };
        });
        await runJob(rowIds.at(-1)!);

        expect(await summaries()).toHaveLength(0);

        // The claim was released with the refusal: the same cut is made again, from the edited rows.
        await runJob(rowIds.at(-1)!);

        expect(generateText).toHaveBeenCalledTimes(2);
        expect(await summaries()).toHaveLength(1);
        const [head] = await summaries();

        expect(head?.summary).toBe("The user is planning a trip.");
    });
});

describe("turning the setting off", () => {
    it("erases every summary of the user's threads, in batches", async () => {
        expect.assertions(4);

        await seedThread(ROWS);

        for (let index = 0; index < 4; index += 1) {
            await storeSummary(index + 10, `s${index}`);
        }

        // Someone else's summary stays.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 1,
                    coveredUpToMessageId: rowIds[0],
                    createdAt: 1,
                    summary: "theirs",
                    taintedBy: [],
                    threadId,
                    userId: "someone-else",
                }),
        );

        const first = await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserThreadSummaries, { batch: 3, before: Date.now(), userId: OWNER }));

        expect(first).toBe(true);
        expect(await summaries()).toHaveLength(2);

        const second = await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserThreadSummaries, { batch: 3, before: Date.now(), userId: OWNER }));

        expect(second).toBe(false);
        const left = await summaries();

        expect(left.map((row) => row.summary)).toStrictEqual(["theirs"]);
    });

    it("keeps the summaries made after the user switched it back on while the erase was still pending", async () => {
        expect.assertions(2);

        await seedThread(ROWS);
        await storeSummary(10, "before the opt-out");
        const optedOutAt = Date.now();

        // Switched back on, and a new summary made, before the erase job ran.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 50,
                    coveredUpToMessageId: rowIds[49],
                    createdAt: optedOutAt + 60_000,
                    summary: "after the re-enable",
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );

        const more = await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserThreadSummaries, { before: optedOutAt, userId: OWNER }));

        expect(more).toBe(false);
        const left = await summaries();

        expect(left.map((row) => row.summary)).toStrictEqual(["after the re-enable"]);
    });
});

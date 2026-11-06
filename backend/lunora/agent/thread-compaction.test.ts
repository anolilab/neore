/**
 * Context compaction against the real schema: it folds the older turns into a summary with a boundary, the thread's
 * own rows never change, it needs neither the idle-summary opt-in nor survives only by it, and it refuses what it
 * must (a running reply, a non-owner, a thread too short).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { autoCompactBeforeReply, compactThreadContext, estimateContext, reportedUsageTokens, transcriptTextOf } from "./thread-compaction";
import { COMPACT_KEEP_TURNS } from "./thread-compaction-logic";
import { documentTextPart } from "../chat/lib/attached-text";
import {
    claimKey,
    deleteThreadSummaries,
    dropSummariesFromEdit,
    eraseUserThreadSummaries,
    finishThreadSummary,
    getThreadSummaryForContext,
    prepareThreadSummary,
} from "./thread-summaries";

const { generateText, limits, registry } = vi.hoisted(() => {
    return { generateText: vi.fn(), limits: { maxPathRows: 5000 }, registry: new Map<string, unknown>() };
});

// A small path cap lets a test cross it without thousands of rows.
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
    };
});
// The harness action ctx has no `services`.
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});

const OWNER = "owner-user";
/** Turns in the seeded thread; each is a user row and an assistant row. */
const TURNS = 10;

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
let rowIds: string[];

const insertRow = async (index: number): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: { content: `turn ${index}`, role: index % 2 === 0 ? "user" : "assistant" },
                order: Math.floor(index / 2),
                status: "success",
                stepOrder: index % 2,
                text: `turn ${index}`,
                threadId,
                tool: false,
                userId: OWNER,
            }),
    );

/** The estimated tokens of the seeded thread's last row, as the compaction check reads them. */
const estimate = async (): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const estimated = await estimateContext(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", rowIds.at(-1)));

        return estimated.tokens;
    });

const seedThread = async (turns: number, thread: Record<string, unknown> = {}) => {
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "regular", title: "Long", userId: OWNER, ...thread }));
    rowIds = [];

    for (let index = 0; index < turns * 2; index += 1) {
        rowIds.push(await insertRow(index));
    }
};

const compact = async (args: { anchor?: string; minTokens?: number; userId?: string } = {}) =>
    await harness.action(
        async (ctx: any) =>
            await compactThreadContext(ctx, {
                ...(args.anchor && { anchorMessageId: args.anchor as never }),
                ...(args.minTokens !== undefined && { minTokens: args.minTokens }),
                threadId: threadId as never,
                userId: args.userId ?? OWNER,
            }),
    );

const stored = async (): Promise<{ coveredUpToMessageId: string; kind?: string; summary: string }[]> =>
    await harness.run(async (ctx: any) => await ctx.db.query("threadContextSummaries").collect());

const allMessages = async () => await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

const contextRead = async (promptMessageId?: string) =>
    (await harness.run(async (ctx: any) => await ctx.runQuery(getThreadSummaryForContext, { promptMessageId, threadId }))) as {
        boundary?: { messageId: string; order: number; stepOrder: number };
        summary: string;
    } | null;

beforeAll(async () => {
    registerModule(registry, "agent_thread_summaries", await import("./thread-summaries"));
    registerModule(registry, "agent_thread_compaction", await import("./thread-compaction"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    generateText.mockResolvedValue({ text: "The user is planning a trip.", usage: { inputTokens: 10, outputTokens: 5 } });
});

afterEach(() => {
    harness.close();
    generateText.mockReset();
});

describe("compacting a thread", () => {
    it("folds the older turns into one summary, keeps the last turns verbatim, and leaves every stored message as it was", async () => {
        expect.assertions(6);

        await seedThread(TURNS);

        const before = await allMessages();
        const outcome = await compact();
        const [row] = await stored();

        expect(outcome).toStrictEqual({ compacted: true });
        expect(row?.kind).toBe("compact");
        expect(row?.summary).toBe("The user is planning a trip.");
        // The last COMPACT_KEEP_TURNS turns are kept: the cover ends at the last row of the turn before them.
        expect(row?.coveredUpToMessageId).toBe(rowIds[(TURNS - COMPACT_KEEP_TURNS) * 2 - 1]);
        // The model saw the older turns as evidence, not the kept ones.
        expect(generateText.mock.calls[0]?.[0].prompt).not.toContain(`turn ${TURNS * 2 - 1}`);
        // The acceptance: compaction changes what the model is sent, never the thread.
        expect(await allMessages()).toStrictEqual(before);
    });

    it("hands the context builder a boundary and the notes, with no idle-summary opt-in", async () => {
        expect.assertions(2);

        await seedThread(TURNS);
        await compact();

        const read = await contextRead(rowIds.at(-1));

        expect(read?.summary).toBe("The user is planning a trip.");
        expect(read?.boundary?.messageId).toBe(rowIds[(TURNS - COMPACT_KEEP_TURNS) * 2 - 1]);
    });

    it("does nothing for a thread that is too short, and calls no model", async () => {
        expect.assertions(3);

        await seedThread(2);

        expect(await compact()).toStrictEqual({ compacted: false, reason: "nothing" });
        expect(generateText).not.toHaveBeenCalled();
        expect(await stored()).toHaveLength(0);
    });

    it("extends the summary on a second compaction instead of adding another", async () => {
        expect.assertions(3);

        await seedThread(6);
        await compact();

        for (let index = 12; index < 20; index += 1) {
            rowIds.push(await insertRow(index));
        }

        await compact();

        const rows = await stored();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe("compact");
        // The previous summary rode into the second call as evidence to merge.
        expect(generateText.mock.calls[1]?.[0].prompt).toContain("The user is planning a trip.");
    });

    it("refuses while a reply is running", async () => {
        expect.assertions(2);

        await seedThread(TURNS);
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

        expect(await compact()).toStrictEqual({ compacted: false, reason: "busy" });
        expect(generateText).not.toHaveBeenCalled();
    });

    it("an auto-compact keeps the same two exchanges verbatim as a manual one", async () => {
        await seedThread(TURNS);
        // The prompt the reply answers opens a turn of its own, after the last completed exchange.
        const prompt = await insertRow(TURNS * 2);

        await compact({ anchor: prompt });

        const [row] = await harness.run(async (ctx: any) => await ctx.db.query("threadContextSummaries").collect());

        expect(row?.coveredCount).toBe((TURNS - COMPACT_KEEP_TURNS) * 2);
    });

    it("is for the owner only", async () => {
        expect.assertions(2);

        await seedThread(TURNS);

        expect(await compact({ userId: "someone-else" })).toStrictEqual({ compacted: false, reason: "not_owner" });
        expect(generateText).not.toHaveBeenCalled();
    });

    it.each([
        ["temporary", { isTemporary: true }],
        ["locked", { lockedAt: 1 }],
        ["stateless", { statelessMode: true }],
    ])("refuses a %s thread", async (_name, thread) => {
        expect.assertions(2);

        await seedThread(TURNS, thread);

        expect(await compact()).toStrictEqual({ compacted: false, reason: "unavailable" });
        expect(generateText).not.toHaveBeenCalled();
    });

    it("stores nothing and frees the cut when the model call fails, so the next try can run", async () => {
        expect.assertions(4);

        await seedThread(TURNS);
        generateText.mockRejectedValueOnce(new Error("gateway down"));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(await compact()).toStrictEqual({ compacted: false, reason: "failed" });
        expect(await stored()).toHaveLength(0);
        expect(await compact()).toStrictEqual({ compacted: true });
        expect(await stored()).toHaveLength(1);
    });

    it("stores nothing for an empty answer: the turns would go with nothing to stand in for them", async () => {
        expect.assertions(2);

        await seedThread(TURNS);
        generateText.mockResolvedValue({ text: " ".repeat(3), usage: {} });

        expect(await compact()).toStrictEqual({ compacted: false, reason: "failed" });
        expect(await stored()).toHaveLength(0);
    });

    it("records an attached document's text as file taint once the compaction stands in for it", async () => {
        expect.assertions(1);

        await seedThread(TURNS);
        // The first prompt carried an attached document, which reaches the message as a plain text part.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.patch("messages", rowIds[0], {
                    message: { content: [{ text: "turn 0", type: "text" }, documentTextPart("notes.pdf", "Quarterly numbers")], role: "user" },
                }),
        );
        await compact();

        const [row] = (await stored()) as unknown as { taintedBy: string[] }[];

        expect(row?.taintedBy).toContain("files");
    });

    it.each([
        ["an edit of a covered reply", async (ctx: any) => await dropSummariesFromEdit(ctx, threadId as never, 0)],
        [
            "a lock and an unlock",
            async (ctx: any) => {
                await deleteThreadSummaries(ctx, threadId as never);
            },
        ],
    ])("compacts the same cut again at once after %s erased the compaction", async (_name, erase) => {
        expect.assertions(3);

        await seedThread(TURNS);
        await compact();
        await harness.run(erase);

        expect(await stored()).toHaveLength(0);
        // The claim on the erased cut went with it: the new compaction is not refused as busy.
        expect(await compact()).toStrictEqual({ compacted: true });
        expect(await stored()).toHaveLength(1);
    });

    it("does not move the boundary over rows with no text when no summary stands in for them", async () => {
        expect.assertions(3);

        await seedThread(TURNS);
        // No row has words of its own: a first cut would store an empty summary and drop the rows with nothing in their place.
        await harness.run(async (ctx: any) => {
            for (const id of rowIds) {
                await ctx.db.patch("messages", id, { text: " " });
            }
        });

        const outcome = await harness.action(async (ctx: any) => await compactThreadContext(ctx, { threadId: threadId as never, userId: OWNER }));

        expect(outcome).toStrictEqual({ compacted: false, reason: "nothing" });
        expect(await stored()).toHaveLength(0);
        expect(generateText).not.toHaveBeenCalled();
    });

    it("folds a long thread from its recent window, so the cover lands where the context builder reads it", async () => {
        expect.assertions(3);

        // Far more rows than the read reach, each as long as the transcript keeps: from the top of the path, five
        // passes would end their cover out of the reader's reach.
        threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "regular", title: "Long", userId: OWNER }));
        rowIds = [];

        for (let index = 0; index < 300; index += 1) {
            rowIds.push(
                await harness.run(
                    async (ctx: any) =>
                        await ctx.db.insert("messages", {
                            message: { content: "long", role: index % 2 === 0 ? "user" : "assistant" },
                            order: Math.floor(index / 2),
                            status: "success",
                            stepOrder: index % 2,
                            text: `turn ${index}:${"x".repeat(1490)}`,
                            threadId,
                            tool: false,
                            userId: OWNER,
                        }),
                ),
            );
        }

        expect(await compact()).toStrictEqual({ compacted: true });
        // The rows above the window are not sent to the model, so no pass reads them.
        expect(generateText.mock.calls.some(([call]) => String(call.prompt).includes("turn 0:"))).toBe(false);
        const read = await contextRead(rowIds.at(-1));

        expect(read?.boundary).toBeDefined();
    });

    it("never carries an idle summary's text into a compaction, which outlives the idle-summary opt-out", async () => {
        expect.assertions(4);

        await seedThread(TURNS);
        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { threadSummariesEnabled: true, userId: OWNER }));
        // An idle summary of the first two turns, counted from the top of the path as the summariser stores it.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 4,
                    coveredUpToMessageId: rowIds[3],
                    createdAt: Date.now() - 1000,
                    summary: "an idle summary",
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await compact()).toStrictEqual({ compacted: true });
        expect(generateText.mock.calls.some(([call]) => String(call.prompt).includes("an idle summary"))).toBe(false);
        // The compaction, not the idle summary, is what the next reply reads from.
        const read = await contextRead(rowIds.at(-1));

        expect(read?.boundary?.messageId).toBe(rowIds[(TURNS - COMPACT_KEEP_TURNS) * 2 - 1]);

        await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserThreadSummaries, { before: Date.now(), userId: OWNER }));

        const left = await stored();

        expect(left.map((row) => row.summary)).toStrictEqual(["The user is planning a trip."]);
    });

    it("folds from after an idle summary the reader sends, and keeps that summary in the notes beside it", async () => {
        expect.assertions(4);

        await seedThread(TURNS);
        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { threadSummariesEnabled: true, userId: OWNER }));
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 4,
                    coveredUpToMessageId: rowIds[3],
                    createdAt: Date.now() - 1000,
                    summary: "an idle summary",
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await compact()).toStrictEqual({ compacted: true });

        const prompt = String(generateText.mock.calls[0]?.[0].prompt);

        // The idle summary still stands in for the first two turns, so the compaction starts after them.
        expect(prompt.includes("turn 0") || prompt.includes("turn 3")).toBe(false);

        const read = await contextRead(rowIds.at(-1));

        expect(read?.boundary?.messageId).toBe(rowIds[(TURNS - COMPACT_KEEP_TURNS) * 2 - 1]);
        // Older turns first, then the compaction: the model keeps what it knew about the turns above the compaction.
        expect(read?.summary).toBe("an idle summary\n\nThe user is planning a trip.");
    });

    it("lets a refusal before the first model call through and costs nothing", async () => {
        expect.assertions(2);

        await seedThread(TURNS);

        await expect(
            harness.action(
                async (ctx: any) =>
                    await compactThreadContext(ctx, {
                        beforeFirstCall: async () => {
                            throw new Error("daily limit");
                        },
                        threadId: threadId as never,
                        userId: OWNER,
                    }),
            ),
        ).rejects.toThrow("daily limit");
        expect(generateText).not.toHaveBeenCalled();
    });
});

describe("auto-compact", () => {
    it("does nothing while the context is below the threshold", async () => {
        expect.assertions(2);

        await seedThread(TURNS);
        await harness.action(
            async (ctx: any) =>
                await autoCompactBeforeReply(ctx, {
                    anchorMessageId: rowIds.at(-2) as never,
                    contextWindow: 200_000,
                    threadId: threadId as never,
                    thresholdPercent: 80,
                    userId: OWNER,
                }),
        );

        expect(generateText).not.toHaveBeenCalled();
        expect(await stored()).toHaveLength(0);
    });

    // The two exchanges the keep point holds verbatim (COMPACT_KEEP_TURNS): a thread of exactly that many has nothing to fold.
    it("folds nothing when the thread holds exactly the exchanges kept verbatim", async () => {
        expect.assertions(2);

        await seedThread(COMPACT_KEEP_TURNS);
        const prompt = await insertRow(COMPACT_KEEP_TURNS * 2);

        await harness.action(
            async (ctx: any) =>
                await autoCompactBeforeReply(ctx, {
                    anchorMessageId: prompt as never,
                    contextWindow: 40,
                    threadId: threadId as never,
                    thresholdPercent: 60,
                    userId: OWNER,
                }),
        );

        expect(generateText).not.toHaveBeenCalled();
        expect(await stored()).toHaveLength(0);
    });

    it("folds exactly one exchange when the thread holds one more than the kept ones", async () => {
        expect.assertions(2);

        await seedThread(COMPACT_KEEP_TURNS + 1);
        const prompt = await insertRow((COMPACT_KEEP_TURNS + 1) * 2);

        // A window of a few tokens makes the seeded rows pass the threshold.
        await harness.action(
            async (ctx: any) =>
                await autoCompactBeforeReply(ctx, {
                    anchorMessageId: prompt as never,
                    contextWindow: 4,
                    threadId: threadId as never,
                    thresholdPercent: 50,
                    userId: OWNER,
                }),
        );

        const [row] = await stored();

        // The first exchange is folded: its assistant row (the second row) is the last one covered.
        expect(row?.coveredUpToMessageId).toBe(rowIds[1]);
        const rows = await harness.run(async (ctx: any) => await ctx.db.query("threadContextSummaries").collect());

        expect(rows[0]?.coveredCount).toBe(2);
    });

    it("compacts before the reply once the context passes the threshold, keeping the prompt's turn", async () => {
        expect.assertions(2);

        await seedThread(TURNS);
        // The reply is about to answer a prompt that has none yet: it opens a turn of its own.
        const prompt = await insertRow(TURNS * 2);

        // A tiny window makes the seeded rows fill it.
        await harness.action(
            async (ctx: any) =>
                await autoCompactBeforeReply(ctx, {
                    anchorMessageId: prompt as never,
                    contextWindow: 40,
                    threadId: threadId as never,
                    thresholdPercent: 60,
                    userId: OWNER,
                }),
        );

        const [row] = await stored();

        expect(row?.kind).toBe("compact");
        // The two completed exchanges before the prompt stay verbatim, as a manual compaction keeps them.
        expect(row?.coveredUpToMessageId).toBe(rowIds[(TURNS - COMPACT_KEEP_TURNS) * 2 - 1]);
    });

    it("never fails the reply: a failed call is swallowed", async () => {
        expect.assertions(2);

        await seedThread(TURNS);
        generateText.mockRejectedValue(new Error("gateway down"));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(
            harness.action(
                async (ctx: any) =>
                    await autoCompactBeforeReply(ctx, {
                        anchorMessageId: rowIds.at(-2) as never,
                        contextWindow: 40,
                        threadId: threadId as never,
                        thresholdPercent: 60,
                        userId: OWNER,
                    }),
            ),
        ).resolves.toBe(false);
        expect(await stored()).toHaveLength(0);
    });
});

describe("the reported usage after a compaction", () => {
    const row = (creationTime: number, extra: Record<string, unknown> = {}) =>
        ({ _creationTime: creationTime, message: { content: "hi", role: "user" }, status: "success", text: "hi", ...extra }) as never;

    it("ignores usage recorded before the compaction: that request still held the folded turns", () => {
        expect.assertions(2);

        const rows = [row(300), row(200, { usage: { completionTokens: 1000, promptTokens: 50_000 } })];

        expect(reportedUsageTokens(rows, 250)).toBe(0);
        expect(reportedUsageTokens(rows, 150)).toBeGreaterThan(51_000);
    });

    it("leaves a failed row after the reported one out of the estimate, as the reply does", () => {
        expect.assertions(1);

        const failed = row(300, { status: "failed", text: "x".repeat(400_000) });
        const reported = row(200, { usage: { completionTokens: 0, promptTokens: 100 } });

        expect(reportedUsageTokens([failed, reported])).toBe(100);
    });

    it("counts the images and files of the rows after the reported one", () => {
        expect.assertions(1);

        const withImage = row(300, { message: { content: [{ image: "storage:a", type: "image" }], role: "user" }, text: "" });
        const plain = row(300, { text: "" });
        const reported = row(200, { usage: { completionTokens: 0, promptTokens: 100 } });

        expect(reportedUsageTokens([withImage, reported])).toBeGreaterThan(reportedUsageTokens([plain, reported]));
    });

    it("does not count a failed reply, which the model is never sent", async () => {
        expect.assertions(1);

        await seedThread(TURNS);

        await harness.run(async (ctx: any) => await ctx.db.patch("messages", rowIds[0], { status: "failed", text: "x".repeat(400_000) }));

        expect(await estimate()).toBeLessThan(1000);
    });

    it("counts the images of an unanswered prompt, which have no stored text", async () => {
        expect.assertions(1);

        await seedThread(TURNS);
        const textOnly = await estimate();

        await harness.run(
            async (ctx: any) =>
                await ctx.db.patch("messages", rowIds.at(-1), {
                    message: {
                        content: [
                            { image: "storage:a", type: "image" },
                            { text: "what is this", type: "text" },
                        ],
                        role: "user",
                    },
                    text: "what is this",
                }),
        );

        expect(await estimate()).toBeGreaterThan(textOnly + 1000);
    });

    it("estimates a just-compacted thread from what the model is sent now, not the last reply's old usage", async () => {
        expect.assertions(1);

        await seedThread(TURNS);
        // The last reply reports the size of the request before any compaction.
        await harness.run(async (ctx: any) => await ctx.db.patch("messages", rowIds.at(-1), { usage: { completionTokens: 1000, promptTokens: 90_000 } }));
        await compact();

        const { tokens } = await harness.run(async (ctx: any) => {
            const thread = await ctx.db.get("threads", threadId);

            return await estimateContext(ctx, thread, await ctx.db.get("messages", rowIds.at(-1)));
        });

        expect(tokens).toBeLessThan(1000);
    });
});

describe("a long path with no compaction to extend", () => {
    it("folds from its window instead of refusing a path past the cap", async () => {
        expect.assertions(2);

        limits.maxPathRows = 150;

        try {
            await seedThread(100);
            const outcome = await compact();
            const rows = await stored();

            expect(outcome.compacted).toBe(true);
            expect(rows).toHaveLength(1);
        } finally {
            limits.maxPathRows = 5000;
        }
    });
});

describe("what the summariser reads of a row", () => {
    it("names the calls an assistant row made, when it has no text of its own", () => {
        expect.assertions(1);

        const call = {
            message: { content: [{ input: { city: "Berlin" }, toolCallId: "c1", toolName: "weather", type: "tool-call" }], role: "assistant" },
            text: "",
        };

        expect(transcriptTextOf(call as never)).toBe('[tool calls]\nweather: {"city":"Berlin"}');
    });

    it("reads the text of a tool result and names its media, so a large image cannot crowd out the text after it", () => {
        expect.assertions(1);

        const result = {
            message: {
                content: [
                    {
                        output: {
                            type: "content",
                            value: [
                                { data: "A".repeat(500_000), mediaType: "image/png", type: "image-data" },
                                { text: "the chart shows growth", type: "text" },
                            ],
                        },
                        toolName: "chart",
                        type: "tool-result",
                    },
                ],
                role: "tool",
            },
            text: "",
        };

        expect(transcriptTextOf(result as never)).toBe("[tool results]\nchart: [image-data]\nthe chart shows growth");
    });
});

describe("the idle-summary opt-out", () => {
    it("erases idle summaries but leaves a compaction, which the owner asked for", async () => {
        expect.assertions(2);

        await seedThread(TURNS);
        await compact();
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 1,
                    coveredUpToMessageId: rowIds[0],
                    createdAt: Date.now() - 1000,
                    summary: "an idle summary",
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );
        await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserThreadSummaries, { before: Date.now(), userId: OWNER }));

        const rows = await stored();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe("compact");
    });

    // Enough turns that the idle summariser has rows past its window to fold.
    const LONG_TURNS = 70;

    const prepareIdle = async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { threadSummariesEnabled: true, userId: OWNER }));

        return await harness.run(async (ctx: any) => await ctx.runMutation(prepareThreadSummary, { afterMessageId: rowIds.at(-1), threadId }));
    };

    it("lets the idle summariser fold a long thread that holds no compaction", async () => {
        expect.assertions(1);

        await seedThread(LONG_TURNS);

        expect(await prepareIdle()).not.toBeNull();
    });

    it("claims its cut under the compaction's scope, so a compaction of the same cut is refused before its model call", async () => {
        await seedThread(LONG_TURNS);
        const prepared = await prepareIdle();

        expect(prepared).not.toBeNull();
        const claims = await harness.run(async (ctx: any) => await ctx.db.query("idempotencyClaims").collect());

        expect(claims).toContainEqual(expect.objectContaining({ key: claimKey(threadId, prepared?.coveredUpToMessageId ?? ""), scope: "thread-cut" }));
    });

    it("refuses to store an idle summary prepared before a compaction landed on its path", async () => {
        expect.assertions(3);

        await seedThread(LONG_TURNS);

        const job = (await prepareIdle()) as Record<string, any> | null;

        expect(job).not.toBeNull();

        // A compaction stored while the idle run's model call was out.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 2,
                    coveredUpToMessageId: rowIds[1],
                    createdAt: Date.now(),
                    kind: "compact",
                    summary: "a compaction",
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );

        const wrote = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(finishThreadSummary, {
                    coveredCount: job?.coveredCount,
                    coveredUpToMessageId: job?.coveredUpToMessageId,
                    epoch: job?.epoch,
                    summary: "an idle summary",
                    taintedBy: job?.taintedBy,
                    threadId,
                }),
        );

        const left = await stored();

        expect(wrote).toBe(false);
        expect(left.map((row) => row.summary)).toStrictEqual(["a compaction"]);
    });

    it("never lets the idle summariser extend a compaction while the reader still reads it", async () => {
        expect.assertions(1);

        await seedThread(LONG_TURNS);
        // A compaction of the first turn only: well over a window of rows still lies past it for the summariser to fold.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: 2,
                    coveredUpToMessageId: rowIds[1],
                    createdAt: Date.now(),
                    kind: "compact",
                    summary: "a compaction",
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await prepareIdle()).toBeNull();
    });

    // Enough turns that the leaf lies past the reader's reach from a compaction of the first turn.
    const PAST_REACH_TURNS = 100;

    const insertCompaction = async (index: number, summary: string): Promise<void> =>
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadContextSummaries", {
                    coveredCount: index + 1,
                    coveredUpToMessageId: rowIds[index],
                    createdAt: Date.now(),
                    kind: "compact",
                    summary,
                    taintedBy: [],
                    threadId,
                    userId: OWNER,
                }),
        );

    const finishIdle = async (job: Record<string, any> | null, summary: string) =>
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(finishThreadSummary, {
                    coveredCount: job?.coveredCount,
                    coveredUpToMessageId: job?.coveredUpToMessageId,
                    epoch: job?.epoch,
                    ...(job?.previousSummaryId && { previousSummaryId: job.previousSummaryId }),
                    summary,
                    taintedBy: job?.taintedBy,
                    threadId,
                }),
        );

    it("rolls idle summaries on, from the compaction, once the thread has grown past the reader's reach of it", async () => {
        expect.assertions(7);

        await seedThread(PAST_REACH_TURNS);

        await insertCompaction(1, "a compaction");

        const job = (await prepareIdle()) as Record<string, any> | null;

        expect(job).not.toBeNull();
        // The fold starts after the compaction's cover and reads its text, so the compacted turns stay in the notes.
        expect(job?.previousSummary).toBe("a compaction");
        expect(job?.coveredCount).toBeGreaterThan(2);

        expect(await finishIdle(job, "an idle summary")).toBe(true);
        // The compaction row is the owner's: an idle write never replaces it.
        const both = await stored();

        expect(both.map((row) => row.summary).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["a compaction", "an idle summary"]);
        expect(await contextRead()).toStrictEqual({ branched: false, summary: "an idle summary" });

        await harness.run(async (ctx: any) => await ctx.runMutation(eraseUserThreadSummaries, { before: Date.now() + 1, userId: OWNER }));

        const left = await stored();

        expect(left.map((row) => row.coveredUpToMessageId)).toStrictEqual([rowIds[1]]);
    });

    it("refuses to store an idle summary rolled from a compaction once a newer compaction landed on its path", async () => {
        expect.assertions(3);

        await seedThread(PAST_REACH_TURNS);
        await insertCompaction(1, "a compaction");

        const job = (await prepareIdle()) as Record<string, any> | null;

        expect(job).not.toBeNull();

        // Stored while the idle run's model call was out, where a compaction folds to: the start of the recent window.
        await insertCompaction(100, "a newer compaction");

        expect(await finishIdle(job, "an idle summary")).toBe(false);
        const left = await stored();

        expect(left.map((row) => row.summary).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["a compaction", "a newer compaction"]);
    });
});

/**
 * The cost of a context reset on the path a reply reads: a reply reads the thread's pointer, so a long history costs a
 * constant number of reads, and a branch change is the only thing that walks the path.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextResetOnPath, refreshContextResetPointer, resetForTip } from "../agent/context-reset";
import { contextResetRowContent } from "../agent/context-reset-shape";
import { collectHandoffSource } from "../agent/handoff-source";
import schema from "../schema";
import { clearContextRowHandler } from "./context-reset";

const walks = vi.hoisted(() => {
    return { count: 0 };
});

// A small page bound lets a test cross it without thousands of rows: the reset walk reaches as far as these two do.
vi.mock("../agent/handoff-source", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../agent/handoff-source")>()), MAX_SEARCH_PAGES: 2 };
});
vi.mock("../agent/thread-summary-logic", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../agent/thread-summary-logic")>()), SUMMARY_MAX_PATH_ROWS: 200 };
});

vi.mock("../agent/branch-rows", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agent/branch-rows")>();

    return {
        ...original,
        walkPath: (...args: Parameters<typeof original.walkPath>) => {
            walks.count += 1;

            return original.walkPath(...args);
        },
    };
});

const OWNER = "owner-user";
const A = "openai/gpt-4.1-mini";
const HISTORY = 300;

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);
const text = (role: "assistant" | "user", value: string) =>
    role === "user" ? { content: value, role } : { content: [{ text: value, type: "text" as const }], role };

/** Seeds `HISTORY` turns on the thread after `orderOffset`, oldest first, and returns the id of the last one. */
const seedHistory = async (orderOffset = 0): Promise<string> =>
    await run(async (ctx) => {
        let last = "";

        for (let index = 0; index < HISTORY; index += 1) {
            const role = index % 2 === 0 ? "user" : "assistant";

            last = await ctx.db.insert("messages", {
                message: text(role, `turn ${index}`),
                order: orderOffset + Math.floor(index / 2),
                status: "success",
                stepOrder: index % 2,
                threadId,
                tool: false,
                userId: OWNER,
            });
        }

        return last;
    });

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: A, status: "active", title: "Long", userId: OWNER }));
    walks.count = 0;
});

afterEach(() => {
    harness.close();
});

describe("a context reset costs a constant number of reads on a reply", () => {
    it("does no path walk for a long thread that was never cleared", async () => {
        const tipId = await seedHistory();

        const reset = await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", tipId)));

        expect(reset).toBeNull();
        expect(walks.count).toBe(0);
    });

    it("reads a cleared thread's reset from its pointer, however long the history after it", async () => {
        await seedHistory();
        await run(async (ctx) => await clearContextRowHandler(ctx, { clientId: "click-long", threadId: threadId as never, userId: OWNER }));
        const tipId = await seedHistory(1000);

        walks.count = 0;

        const reset = await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", tipId)));

        expect(reset).not.toBeNull();
        expect(walks.count).toBe(0);
    });

    it("refreshes the pointer when the path changes, so a branch the person left does not apply the reset", async () => {
        const turn = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("user", "first"),
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const answer = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("assistant", "answer"),
                    order: 0,
                    parentMessageId: turn,
                    status: "success",
                    stepOrder: 1,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const { messageId } = await run(
            async (ctx) => await clearContextRowHandler(ctx, { clientId: "click-branch", threadId: threadId as never, userId: OWNER }),
        );
        const alternative = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("user", "another way"),
                    order: 1,
                    parentMessageId: answer,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        // The person moved to the branch that never saw the reset: its pointer is "none".
        await run(async (ctx) => await refreshContextResetPointer(ctx, threadId as never, alternative));
        const pointed = await run(async (ctx) => await ctx.db.get("threads", threadId));

        expect(pointed.contextResetMessageId).toBe("");
        expect(await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", alternative)))).toBeNull();

        // Back on the branch with the reset: the pointer names it again.
        await run(async (ctx) => await refreshContextResetPointer(ctx, threadId as never, messageId));
        const repointed = await run(async (ctx) => await ctx.db.get("threads", threadId));

        expect(repointed.contextResetMessageId).toBe(messageId);
    });

    it("does not cut a prompt on another branch with the reset on the active path", async () => {
        const turn = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("user", "first"),
                    order: 0,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const answer = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("assistant", "answer"),
                    order: 0,
                    parentMessageId: turn,
                    status: "success",
                    stepOrder: 1,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );
        const { messageId } = await run(
            async (ctx) => await clearContextRowHandler(ctx, { clientId: "click-other", threadId: threadId as never, userId: OWNER }),
        );
        const other = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("user", "another way"),
                    order: 2,
                    parentMessageId: answer,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        // The thread is branched and its active path ends at the reset, which the pointer names.
        await run(async (ctx) => await ctx.db.patch("threads", threadId, { activeLeafMessageId: messageId, contextResetMessageId: messageId }));

        expect(await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", other)))).toBeNull();
    });

    it("searches the path for a reset only as far as the page bound", async () => {
        const tipId = await seedHistory();

        walks.count = 0;

        const reset = await run(async (ctx) => await contextResetOnPath(ctx, threadId as never, await ctx.db.get("messages", tipId)));

        expect(reset).toBeNull();
        expect(walks.count).toBe(2);
    });

    it("hands no turn from before the reset to another agent", async () => {
        await seedHistory();
        await run(async (ctx) => await clearContextRowHandler(ctx, { clientId: "click-handoff", threadId: threadId as never, userId: OWNER }));
        const after = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("user", "after the clear"),
                    order: 1000,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        const source = await run(async (ctx) => await collectHandoffSource(ctx, threadId as never, await ctx.db.get("messages", after)));

        expect(source.turns.map((turn) => turn.text)).toStrictEqual(["after the clear"]);
        expect(source.omittedEarlier).toBe(false);
    });

    it("keeps the turns before the reset for a prompt written before it", async () => {
        const earlier = await seedHistory();

        await run(async (ctx) => await clearContextRowHandler(ctx, { clientId: "click-earlier", threadId: threadId as never, userId: OWNER }));
        await seedHistory(1000);

        const reset = await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", earlier)));

        expect(reset).toBeNull();
    });

    it("reads the newest reset on a prompt's branch, though the active path's pointer names an older one", async () => {
        const insert = async (fields: Record<string, unknown>) =>
            await run(async (ctx) => await ctx.db.insert("messages", { status: "success", threadId, tool: false, userId: OWNER, ...fields }));
        const turn = await insert({ message: text("user", "first"), order: 0, stepOrder: 0 });
        const answer = await insert({ message: text("assistant", "answer"), order: 0, parentMessageId: turn, stepOrder: 1 });
        const older = await insert({ ...contextResetRowContent(), order: 1, parentMessageId: answer, stepOrder: 0 });
        const between = await insert({ message: text("user", "between"), order: 2, parentMessageId: older, stepOrder: 0 });
        const newer = await insert({ ...contextResetRowContent(), order: 3, parentMessageId: between, stepOrder: 0 });
        const tip = await insert({ message: text("user", "after both"), order: 4, parentMessageId: newer, stepOrder: 0 });
        // The active path leaves the older reset another way, so the pointer rightly names the older one for it.
        const active = await insert({ message: text("user", "another way"), order: 5, parentMessageId: older, stepOrder: 0 });

        await run(async (ctx) => await ctx.db.patch("threads", threadId, { activeLeafMessageId: active, contextResetMessageId: older, hasContextReset: true }));

        const reset = await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", tip)));

        expect(reset?._id).toBe(newer);
    });

    it("reads the reset a prompt written between two clears lies past", async () => {
        await seedHistory();
        const first = await run(async (ctx) => await clearContextRowHandler(ctx, { clientId: "click-one", threadId: threadId as never, userId: OWNER }));
        const between = await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("user", "between the clears"),
                    order: 1000,
                    status: "success",
                    stepOrder: 0,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        // Answered, so the second clear is not refused for a reply that has not started.
        await run(
            async (ctx) =>
                await ctx.db.insert("messages", {
                    message: text("assistant", "an answer"),
                    order: 1000,
                    status: "success",
                    stepOrder: 1,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        await run(async (ctx) => await clearContextRowHandler(ctx, { clientId: "click-two", threadId: threadId as never, userId: OWNER }));

        const reset = await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), await ctx.db.get("messages", between)));

        expect(reset?._id).toBe(first.messageId);
    });

    it("reads a branched thread's pointer for a prompt on the active path with one short walk, even when it names no reset", async () => {
        const tipId = await seedHistory();
        const leaf = await run(async (ctx) => await ctx.db.get("messages", tipId));

        // Cleared once, then the person moved to a path without the reset: the pointer is "none".
        await run(async (ctx) => await ctx.db.patch("threads", threadId, { activeLeafMessageId: leaf._id, contextResetMessageId: "", hasContextReset: true }));
        walks.count = 0;

        const reset = await run(async (ctx) => await resetForTip(ctx, await ctx.db.get("threads", threadId), leaf));

        expect(reset).toBeNull();
        expect(walks.count).toBe(1);
    });
});

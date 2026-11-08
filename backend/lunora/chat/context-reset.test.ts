/**
 * `/clear` against the real schema: the reset row's place in the thread, what the model is sent after it, and the
 * refusals. The reply window is cut by the same helpers the reader uses (`agent/context-reset.ts`).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contextResetOnPath, MAX_RESET_WALK_PAGES, rowsAfterContextReset } from "../agent/context-reset";
import { isContextResetRow } from "../agent/context-reset-shape";
import { handoffAboveOf } from "../agent/agent-switch";
import { docsToModelMessages } from "../agent/mapping";
import { addMessagesHandler } from "../agent/messages";
import { insertAgentSwitchRow } from "../agent/table-writes";
import { THREAD_FOLD_CLAIM_SCOPE } from "../agent/thread-compaction-logic";
import { SUMMARY_MAX_PATH_ROWS } from "../agent/thread-summary-logic";
import { claimOnce } from "../lib/claim-once";
import schema from "../schema";
import { clearContextRowHandler } from "./context-reset";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-user";
const ALREADY_MADE = /already made/u;
const COLLABORATOR = "collaborator-user";
const A = "openai/gpt-4.1-mini";

let harness: Harness;
let threadId: string;
const ids: Record<string, string> = {};

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);

const text = (role: "assistant" | "user", value: string) =>
    role === "user" ? { content: value, role } : { content: [{ text: value, type: "text" as const }], role };

const insertRow = async (name: string, order: number, stepOrder: number, message: unknown) => {
    ids[name] = await run(
        async (ctx) => await ctx.db.insert("messages", { message, order, status: "success", stepOrder, threadId, tool: false, userId: OWNER }),
    );
};

const rows = async (): Promise<any[]> => await run(async (ctx) => await ctx.db.query("messages").collect());
const thread = async (): Promise<any> => await run(async (ctx) => await ctx.db.get("threads", threadId));

const clear = async (userId = OWNER, clientId = crypto.randomUUID()) =>
    await run(async (ctx) => await clearContextRowHandler(ctx, { clientId, threadId: threadId as never, userId }));

/**
 * What a reply whose prompt is `tipId` is sent: the path's rows (oldest first, the unbranched thread's path is every row
 * up to the tip), cut at the newest reset on it, then the model's messages.
 */
const modelInput = async (tipId: string): Promise<string[]> =>
    await run(async (ctx) => {
        const everything = await ctx.db.query("messages").collect();
        const tip = everything.find((row: any) => row._id === tipId);
        const path = everything.filter((row: any) => row.order <= tip.order).toSorted((a: any, b: any) => a.order - b.order || a.stepOrder - b.stepOrder);
        const reset = await contextResetOnPath(ctx, threadId as never, tip);

        return docsToModelMessages(rowsAfterContextReset(path, reset) as never).map((message: any) =>
            typeof message.content === "string" ? message.content : message.content[0].text,
        );
    });

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: A, status: "active", title: "T", userId: OWNER }));
    await insertRow("u1", 0, 0, text("user", "first question"));
    await insertRow("a1", 0, 1, text("assistant", "first answer"));
    await insertRow("u2", 1, 0, text("user", "second question"));
    await insertRow("a2", 1, 1, text("assistant", "second answer"));
});

afterEach(() => {
    harness.close();
});

describe("/clear on a thread that never branched", () => {
    it("writes one reset row after the last row, with no text, and marks the thread", async () => {
        const { messageId } = await clear();
        const all = await rows();
        const reset = all.find((row) => row._id === messageId);

        expect(isContextResetRow(reset)).toBe(true);
        expect(reset).toMatchObject({ message: { content: "", role: "system" }, order: 2, status: "success", stepOrder: 0, tool: false });
        expect(reset.parentMessageId).toBeUndefined();
        expect(await thread()).toMatchObject({ hasContextReset: true });
        // The history is not touched: every earlier row is still there.
        expect(all.filter((row) => row.message.role !== "system")).toHaveLength(4);
    });

    it("sends the model no earlier turn after the reset, and the turns written after it", async () => {
        const { messageId } = await clear();

        expect(await modelInput(messageId)).toStrictEqual([]);

        await run(async (ctx) => {
            await addMessagesHandler(ctx, {
                fromUser: true,
                messages: [{ message: text("user", "third question"), status: "success" }],
                threadId: threadId as never,
                userId: OWNER,
            });
        });
        const all = await rows();
        const newest = all.find((row) => row.message?.content === "third question") as { _id: string };

        expect(await modelInput(newest._id)).toStrictEqual(["third question"]);
    });

    it("sends the earlier turns to a reply on a path that never saw the reset", async () => {
        await clear();

        expect(await modelInput(ids.a2 as string)).toStrictEqual(["first question", "first answer", "second question", "second answer"]);
    });

    it("keeps the rows before the reset in the transcript, and the reset row too", async () => {
        const { messageId } = await clear();
        const all = await rows();
        const visible = all.map((row: any) => row._id);

        expect(visible).toEqual(expect.arrayContaining([ids.u1, ids.a1, ids.u2, ids.a2, messageId]));
    });

    it("writes one reset for one click, and refuses a repeat of the same click", async () => {
        await clear(OWNER, "click-1");

        await expect(clear(OWNER, "click-1")).rejects.toThrow(ALREADY_MADE);
        const all = await rows();

        expect(all.filter((row) => isContextResetRow(row))).toHaveLength(1);
    });

    it("refuses a reset between a prompt and the start of its reply, and allows it once the reply's stream exists", async () => {
        // The prompt is saved; its stream is created by a later mutation.
        await insertRow("u3", 2, 0, text("user", "third question"));

        await expect(clear()).rejects.toMatchObject({ data: { code: "CONTEXT_CLEAR_REPLY_RUNNING" } });
        const written = await rows();

        expect(written.filter((row) => row.message?.role === "system")).toHaveLength(0);

        await run(
            async (ctx) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() - 1000,
                    messageId: ids.u3,
                    status: "done",
                    streamingConfig: { contentType: "text", model: A },
                    threadId,
                    userId: OWNER,
                }),
        );

        await expect(clear()).resolves.toMatchObject({ messageId: expect.any(String) });
    });

    it("refuses a reset while a summary or compaction of the thread is being paid for, so its result is not thrown away", async () => {
        await run(async (ctx) => await claimOnce(ctx, THREAD_FOLD_CLAIM_SCOPE, threadId, 60_000, OWNER));

        await expect(clear()).rejects.toMatchObject({ data: { code: "CONTEXT_CLEAR_SUMMARISING" } });

        const written = await rows();

        expect(written.filter((row) => row.message?.role === "system")).toHaveLength(0);
    });

    it("refuses a reset while the thread is not the requester's own", async () => {
        await expect(clear(COLLABORATOR)).rejects.toThrow();
        expect(await thread()).not.toHaveProperty("hasContextReset", true);
    });
});

describe("a reset is per path", () => {
    it("does not cut a branch the person left, only the one the reset sits on", async () => {
        const { messageId } = await clear();

        expect(await run(async (ctx) => await contextResetOnPath(ctx, threadId as never, await ctx.db.get("messages", ids.a1)))).toBeNull();
        expect(await run(async (ctx) => await contextResetOnPath(ctx, threadId as never, await ctx.db.get("messages", messageId)))).toMatchObject({
            _id: messageId,
        });
    });

    it("cuts by order and never keeps a row at the reset's own order", () => {
        const window = [
            { _id: "a", order: 0 },
            { _id: "b", order: 1 },
            { _id: "c", order: 2 },
        ];

        expect(rowsAfterContextReset(window, { order: 1 }).map((row) => row._id)).toStrictEqual(["c"]);
        expect(rowsAfterContextReset(window, null).map((row) => row._id)).toStrictEqual(["a", "b", "c"]);
    });
});

describe("what counts as a context reset", () => {
    it("is the empty system row only, so a model's message that carries the marker is not one", () => {
        expect(isContextResetRow({ message: { content: "", role: "system" }, providerMetadata: { neoreContextReset: { reason: "clear" } } })).toBe(true);
        expect(
            isContextResetRow({
                message: { content: [{ text: "x", type: "text" }], role: "assistant" },
                providerMetadata: { neoreContextReset: { reason: "clear" } },
            }),
        ).toBe(false);
        expect(isContextResetRow({ message: { content: "", role: "system" }, providerMetadata: {} })).toBe(false);
    });

    it("is not a task run's divider, which marks where that run began and cuts nothing", () => {
        expect(isContextResetRow({ message: { content: "", role: "system" }, providerMetadata: { neoreContextReset: { reason: "task_run" } } })).toBe(false);
    });
});

describe("a stored handoff across a context reset (/clear)", () => {
    const B = "google/gemini-2.0-flash-001";
    const handoffPart = (startMessageId: string, handoff: string) => {
        return {
            from: { kind: "model" as const, model: A },
            handoff,
            mode: "portable" as const,
            startMessageId,
            to: { kind: "model" as const, model: B },
        };
    };

    beforeEach(async () => {
        await run(async (ctx) => {
            await ctx.db.patch("threads", threadId as never, { activeAgent: { kind: "model", model: A }, hasHandoff: true });
        });
    });

    it("does not return a handoff from before the reset to a later reply", async () => {
        await run(async (ctx) => {
            await insertAgentSwitchRow(ctx.db, {
                order: 2,
                part: handoffPart(ids.a2 as string, "before the clear"),
                threadId: threadId as never,
                userId: OWNER,
            });
        });
        await clear();
        await insertRow("u3", 4, 0, text("user", "after the clear"));

        expect(await run(async (ctx) => await handoffAboveOf(ctx, { belowMessageId: ids.u3 as never, threadId: threadId as never }))).toStrictEqual([]);
    });

    it("returns no handoff from before a paused run's own first turn (fromOrder), and keeps one inside it", async () => {
        await run(async (ctx) => {
            await insertAgentSwitchRow(ctx.db, {
                order: 2,
                part: handoffPart(ids.a2 as string, "before the run"),
                threadId: threadId as never,
                userId: OWNER,
            });
        });
        await insertRow("u3", 4, 0, text("user", "the run's task"));

        const above = async (fromOrder: number) =>
            await run(async (ctx) => await handoffAboveOf(ctx, { belowMessageId: ids.u3 as never, fromOrder, threadId: threadId as never }));

        expect(await above(3)).toStrictEqual([]);
        expect(await above(2)).toStrictEqual(["before the run"]);
    });

    it("returns a handoff written by a switch after the reset", async () => {
        await clear();
        await run(async (ctx) => {
            await insertAgentSwitchRow(ctx.db, {
                order: 4,
                part: handoffPart(ids.u1 as string, "after the clear"),
                threadId: threadId as never,
                userId: OWNER,
            });
        });
        await insertRow("u4", 5, 0, text("user", "later"));

        expect(await run(async (ctx) => await handoffAboveOf(ctx, { belowMessageId: ids.u4 as never, threadId: threadId as never }))).toStrictEqual([
            "after the clear",
        ]);
    });
});

describe("how far a reset is looked for", () => {
    it("reaches at least as far up a path as an idle summary reads, so a summary never reads past an unfound reset", () => {
        expect(MAX_RESET_WALK_PAGES * 100).toBeGreaterThanOrEqual(SUMMARY_MAX_PATH_ROWS);
    });
});

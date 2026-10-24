/**
 * Where a steered message and the rest of its reply land, against the real
 * schema. The saves after the steer are the ones `agent/client/start.ts` makes
 * once `takeSteer` retargets the run: the moved pending row is patched, and the
 * steer row is the prompt.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { listActivePathPage } from "./branches";
import { resolveLeafRow } from "./branch-rows";
import { buildBranchTree, continuationOrder, resolveActivePath } from "./branch-tree";
import { addMessagesHandler, getMaxMessage } from "./messages";
import { insertSteerRow } from "./steer-rows";

type Harness = ReturnType<typeof lunoraTest>;
type StoredRow = { _id: string; message?: { role?: string }; order: number; parentMessageId?: string; status?: string; stepOrder: number };

const OWNER = "owner-user";

let harness: Harness;
let threadId: string;
const ids: Record<string, string> = {};

const insertRow = async (name: string, order: number, stepOrder: number, message: unknown, extra: Record<string, unknown> = {}) => {
    ids[name] = await harness.run(
        async (ctx: any) => await ctx.db.insert("messages", { message, order, status: "success", stepOrder, threadId, tool: false, userId: OWNER, ...extra }),
    );
};

const addMessages = async (args: Record<string, unknown>) =>
    await harness.run(async (ctx: any) => await addMessagesHandler(ctx, { threadId: threadId as never, userId: OWNER, ...args } as never));

const allRows = async (): Promise<StoredRow[]> => await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

const rowById = async (id: string): Promise<StoredRow> => {
    const rows = await allRows();

    return rows.find((row) => row._id === id)!;
};

const maxOrderOf = async (): Promise<number | undefined> => {
    const max = await harness.run(async (ctx: any) => await getMaxMessage(ctx, threadId as never));

    return max?.order;
};

const steer = async (pendingMessageId: string, text = "use the other file") =>
    await harness.run(async (ctx: any) => await insertSteerRow(ctx, { pendingMessageId, text, threadId: threadId as never, userId: OWNER }));

const assistantText = (text: string) => {
    return { content: [{ text, type: "text" }], role: "assistant" };
};

const toolCall = { content: [{ input: {}, toolCallId: "call-1", toolName: "readFile", type: "tool-call" }], role: "assistant" };
const toolResult = {
    content: [{ output: { type: "text", value: "contents" }, toolCallId: "call-1", toolName: "readFile", type: "tool-result" }],
    role: "tool",
};
const pendingRow = { message: { content: [], role: "assistant" }, status: "pending" };

/** The path the incremental walk serves, top first, for the thread's stored leaf. */
const walkedPath = async (): Promise<string[]> => {
    const thread = await harness.run(async (ctx: any) => await ctx.db.get(threadId));
    const page: any = await harness.run(async (ctx: any) => await listActivePathPage(ctx, thread, { cursor: null, numItems: 100 }));

    return page.page.map((row: { _id: string }) => row._id).toReversed();
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

    // u1 → a1, then the running turn: u2 → its first step (a tool call and its
    // result) → the pending row the step saved for the next one.
    await insertRow("u1", 0, 0, { content: "hi", role: "user" });
    await insertRow("a1", 0, 1, assistantText("hello"));
    await insertRow("u2", 1, 0, { content: "summarise my file", role: "user" });

    const step = await addMessages({ messages: [{ message: toolCall }, { message: toolResult }, pendingRow], promptMessageId: ids.u2 });

    ids.call = step.messages[0]!._id;
    ids.result = step.messages[1]!._id;
    ids.pending = step.messages[2]!._id;
});

afterEach(() => {
    harness.close();
});

describe("insertSteerRow in a thread that never branched", () => {
    it("puts the steer in a fresh order under the reply so far, and the next step after it", async () => {
        const steered = await steer(ids.pending!);
        const steerRow = await rowById(steered!.messageId);
        const moved = await rowById(ids.pending!);

        expect(steerRow).toMatchObject({ message: { role: "user" }, order: 2, parentMessageId: ids.result, stepOrder: 0 });
        expect(moved).toMatchObject({ order: 2, status: "pending", stepOrder: 1 });
        expect(moved.parentMessageId).toBeUndefined();

        // The reply before the steer did not move.
        expect(await rowById(ids.call!)).toMatchObject({ order: 1, stepOrder: 1 });
        expect(await rowById(ids.result!)).toMatchObject({ order: 1, stepOrder: 2 });
    });

    it("saves the run's later steps after the moved pending row, on one line", async () => {
        const steered = await steer(ids.pending!);
        // `start.ts` after the retarget: the pending row is patched, the steer row is the prompt.
        const next = await addMessages({
            messages: [{ message: assistantText("Reading the other file instead.") }, { message: assistantText("Done.") }],
            pendingMessageId: ids.pending,
            promptMessageId: steered!.messageId,
        });
        const rows = await allRows();
        const tree = buildBranchTree(rows);
        const last = next.messages[1]!._id;

        expect(await rowById(last)).toMatchObject({ order: 2, stepOrder: 2 });
        expect(resolveActivePath(tree)).toStrictEqual([ids.u1, ids.a1, ids.u2, ids.call, ids.result, steered!.messageId, ids.pending, last]);
        // Nothing branched: every row has at most one child.
        expect(rows.every((row) => tree.childrenOf(row._id).length <= 1)).toBe(true);
    });

    it("leaves a later steer of the same run one more order on", async () => {
        const first = await steer(ids.pending!);
        const step = await addMessages({
            messages: [{ message: toolCall }, { message: toolResult }, pendingRow],
            pendingMessageId: ids.pending,
            promptMessageId: first!.messageId,
        });
        const nextPending = step.messages[2]!._id;
        const second = await steer(nextPending, "and keep it short");

        expect(await rowById(second!.messageId)).toMatchObject({ order: 3, parentMessageId: step.messages[1]!._id, stepOrder: 0 });
        expect(await rowById(nextPending)).toMatchObject({ order: 3, stepOrder: 1 });
        expect(resolveActivePath(buildBranchTree(await allRows())).slice(-3)).toStrictEqual([step.messages[1]!._id, second!.messageId, nextPending]);
    });

    it("refuses a run whose pending row has already settled", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(ids.pending, { status: "failed" }));

        expect(await steer(ids.pending!)).toBeNull();
        expect(await allRows()).toHaveLength(6);
    });

    it("refuses a move that would re-parent a row nobody pinned", async () => {
        // A row after the pending one that follows it implicitly.
        await insertRow("late", 2, 0, { content: "another tab", role: "user" });

        expect(await steer(ids.pending!)).toBeNull();
        expect(await rowById(ids.pending!)).toMatchObject({ order: 1, stepOrder: 3 });
        expect(await rowById(ids.late!)).toMatchObject({ order: 2, stepOrder: 0 });
    });
});

describe("insertSteerRow in a branched thread", () => {
    beforeEach(async () => {
        // The conversation went on after a1 (u3 → a3), then the user regenerated
        // a1's prompt, and THAT reply is the run being steered.
        await harness.run(async (ctx: any) => {
            for (const name of ["u2", "call", "result", "pending"]) {
                await ctx.db.delete(ids[name]);
            }
        });
        await insertRow("u3", 1, 0, { content: "thanks", role: "user" });
        await insertRow("a3", 1, 1, assistantText("you're welcome"));
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.u1 }));

        const regenerated = await addMessages({
            failPendingSteps: true,
            messages: [{ message: toolCall }, { message: toolResult }, pendingRow],
            promptMessageId: ids.u1,
        });

        ids.call = regenerated.messages[0]!._id;
        ids.result = regenerated.messages[1]!._id;
        ids.pending = regenerated.messages[2]!._id;
    });

    it("leaves the turn after the earlier order where it was", async () => {
        const before = await rowById(ids.u3!);
        const steered = await steer(ids.pending!);
        const rows = await allRows();
        const tree = buildBranchTree(rows);

        expect(await rowById(ids.u3!)).toStrictEqual(before);
        expect(resolveActivePath(tree, ids.a3)).toStrictEqual([ids.u1, ids.a1, ids.u3, ids.a3]);
        // Past every row, as a continuation's order is.
        expect(await rowById(steered!.messageId)).toMatchObject({ order: continuationOrder(0, 1) });
        expect(tree.parentOf(steered!.messageId)).toBe(ids.result);
        expect(tree.parentOf(ids.pending!)).toBe(steered!.messageId);
    });

    it("keeps the stored leaf on the steered path, and the walk agrees with the whole tree", async () => {
        const steered = await steer(ids.pending!);
        const next = await addMessages({
            messages: [{ message: assistantText("Done.") }],
            pendingMessageId: ids.pending,
            promptMessageId: steered!.messageId,
        });
        const tree = buildBranchTree(await allRows());
        const thread = await harness.run(async (ctx: any) => await ctx.db.get(threadId));
        const leaf = await harness.run(async (ctx: any) => await resolveLeafRow(ctx, threadId as never, thread.activeLeafMessageId));
        const expected = [ids.u1, ids.call, ids.result, steered!.messageId, ids.pending];

        expect(next.messages[0]!._id).toBe(ids.pending);
        expect(leaf?._id).toBe(ids.pending);
        expect(resolveActivePath(tree, thread.activeLeafMessageId)).toStrictEqual(expected);
        expect(await walkedPath()).toStrictEqual(expected);
    });

    it("makes a regenerate of the steered message a sibling under it", async () => {
        const steered = await steer(ids.pending!);

        await addMessages({ messages: [{ message: assistantText("Done.") }], pendingMessageId: ids.pending, promptMessageId: steered!.messageId });
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: steered!.messageId }));

        const again = await addMessages({
            failPendingSteps: true,
            messages: [{ message: assistantText("Done, again.") }],
            promptMessageId: steered!.messageId,
        });
        const tree = buildBranchTree(await allRows());

        expect(tree.childrenOf(steered!.messageId)).toStrictEqual([ids.pending, again.messages[0]!._id]);
        expect(await walkedPath()).toStrictEqual([ids.u1, ids.call, ids.result, steered!.messageId, again.messages[0]!._id]);
    });

    it("makes an edit of the steered message its sibling", async () => {
        const steered = await steer(ids.pending!);
        // What `saveEditedSibling` stores: the original's parent, explicitly.
        const edited = await addMessages({ messages: [{ message: { content: "use the third file", role: "user" } }], parentMessageId: ids.result });
        const tree = buildBranchTree(await allRows());

        expect(tree.childrenOf(ids.result!)).toStrictEqual([steered!.messageId, edited.messages[0]!._id]);
    });

    it("gives a later tool-approval continuation an order past the steered one", async () => {
        const steered = await steer(ids.pending!);
        const steerRow = await rowById(steered!.messageId);

        expect(continuationOrder(0, await maxOrderOf())).toBe(steerRow.order + 1);
    });
});

describe("insertSteerRow in a tool-approval continuation", () => {
    it("moves the continuation's pending row out of its override order, and later saves follow the steer", async () => {
        // The first run paused on an approval instead of going on: no pending row.
        await harness.run(async (ctx: any) => await ctx.db.delete(ids.pending));

        // The continuation owns a fresh order and saves into it (`forceNewOrder`).
        const order = continuationOrder(1, await maxOrderOf());
        const step = await addMessages({
            messages: [{ message: toolCall }, { message: toolResult }, pendingRow],
            overrideOrder: order,
            parentMessageId: ids.result,
        });
        const pending = step.messages[2]!._id;
        const steered = await steer(pending);
        // After the retarget the run no longer passes `overrideOrder` or `parentMessageId`.
        const next = await addMessages({
            messages: [{ message: assistantText("Done.") }, { message: assistantText("More.") }],
            pendingMessageId: pending,
            promptMessageId: steered!.messageId,
        });

        expect(await rowById(steered!.messageId)).toMatchObject({ order: order + 1, parentMessageId: step.messages[1]!._id, stepOrder: 0 });
        expect(await rowById(next.messages[1]!._id)).toMatchObject({ order: order + 1, stepOrder: 2 });
        expect(resolveActivePath(buildBranchTree(await allRows())).slice(-5)).toStrictEqual([
            step.messages[0]!._id,
            step.messages[1]!._id,
            steered!.messageId,
            pending,
            next.messages[1]!._id,
        ]);
    });
});

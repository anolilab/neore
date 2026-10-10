/**
 * A tool-approval continuation inside a branch that is NOT the newest in
 * storage order, driven against the real schema: the approval must still count
 * as pending, and the resumed reply must append to the branch it paused in
 * without colliding on `(order, stepOrder)` with the sibling branch.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findPendingApprovalOnLatestTurn } from "../chat/lib/tool-approval-claim";
import schema from "../schema";
import type { BranchTree } from "./branch-tree";
import { buildBranchTree, continuationOrder, resolveActivePath } from "./branch-tree";
import { getForkContextIds, listActivePathPage, resolveForkEnd } from "./branches";
import { addMessagesHandler, cloneMessageBatch, getMaxMessage } from "./messages";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-user";
const APPROVAL_ID = "approval-1";

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

const allRows = async (): Promise<{ _id: string; order: number; parentMessageId?: string; stepOrder: number }[]> =>
    await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

const assistantText = (text: string) => {
    return { content: [{ text, type: "text" }], role: "assistant" };
};

/** Sibling info from the whole-thread tree, as the oracle the walk must match. */
const branchInfo = (tree: BranchTree, id: string) => {
    const parent = tree.parentOf(id);
    const siblingIds = parent === undefined ? [] : [...tree.childrenOf(parent)];

    return siblingIds.length < 2 ? undefined : { count: siblingIds.length, index: siblingIds.indexOf(id), siblingIds };
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

    // u1 → { aOld (paused on an approval), aNew → u2 → a2 }. aNew was a
    // regenerate, and the conversation carried on from it; the user then
    // switched back to aOld, whose request is still open.
    await insertRow("u1", 0, 0, { content: "delete my file", role: "user" });
    await insertRow(
        "aOld",
        0,
        1,
        {
            content: [
                { input: {}, toolCallId: "call-1", toolName: "mcp_Files__delete", type: "tool-call" },
                { approvalId: APPROVAL_ID, toolCallId: "call-1", type: "tool-approval-request" },
            ],
            role: "assistant",
        },
        { tool: true },
    );
    await insertRow("aNew", 0, 2, assistantText("done differently"), { parentMessageId: ids.u1 });
    await insertRow("u2", 1, 0, { content: "thanks", role: "user" });
    await insertRow("a2", 1, 1, assistantText("you're welcome"));
    await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.aOld }));
});

afterEach(() => {
    harness.close();
});

describe("inserting into an earlier turn", () => {
    it("does not re-parent the turn that followed it (regenerate in a legacy thread)", async () => {
        // A thread written before branching: u1 → a1 → u2 → a2, no parent ids.
        await harness.run(async (ctx: any) => {
            const existing = await ctx.db.query("messages").collect();

            for (const row of existing) {
                await ctx.db.delete(row._id);
            }
        });
        await insertRow("u1", 0, 0, { content: "hi", role: "user" });
        await insertRow("a1", 0, 1, assistantText("hello"));
        await insertRow("u2", 1, 0, { content: "more", role: "user" });
        await insertRow("a2", 1, 1, assistantText("sure"));

        // Regenerate a1: the new reply's pending row lands at the end of order 0.
        const saved = await addMessages({
            failPendingSteps: true,
            messages: [{ message: { content: [], role: "assistant" }, status: "pending" }],
            promptMessageId: ids.u1,
        });
        const tree = buildBranchTree(await allRows());

        expect(resolveActivePath(tree, ids.a2)).toStrictEqual([ids.u1, ids.a1, ids.u2, ids.a2]);
        expect(resolveActivePath(tree, ids.u1)).toStrictEqual([ids.u1, saved.messages[0]?._id]);
    });
});

describe("tool approval inside an older branch", () => {
    it("still counts the request as pending on the active path", async () => {
        const pending = await harness.run(async (ctx: any) => await findPendingApprovalOnLatestTurn(ctx, threadId as never, APPROVAL_ID));

        expect(pending).toStrictEqual({ toolName: "mcp_Files__delete" });
    });

    it("appends the tool result and the continuation to the paused branch without collisions", async () => {
        const toolResult = await addMessages({
            messages: [
                {
                    message: {
                        content: [
                            { approvalId: APPROVAL_ID, approved: true, type: "tool-approval-response" },
                            { output: { type: "text", value: "deleted" }, toolCallId: "call-1", toolName: "mcp_Files__delete", type: "tool-result" },
                        ],
                        role: "tool",
                    },
                },
            ],
            promptMessageId: ids.aOld,
        });
        const toolResultId = toolResult.messages[0]?._id as string;

        // What `start.ts` computes for `forceNewOrder`; `order + 1` would be u2's.
        const lastRow = await harness.run(async (ctx: any) => await getMaxMessage(ctx, threadId as never));
        const order = continuationOrder(0, lastRow?.order);

        expect(order).toBe(2);

        // Two step saves into the same continuation, as the agent loop does.
        await addMessages({ messages: [{ message: assistantText("step 1") }], overrideOrder: order, parentMessageId: toolResultId });
        await addMessages({ messages: [{ message: assistantText("step 2") }], overrideOrder: order, parentMessageId: toolResultId });

        const rows = await allRows();
        const slots = rows.map((row) => `${String(row.order)}:${String(row.stepOrder)}`);

        expect(new Set(slots).size).toBe(slots.length);

        const tree = buildBranchTree(rows);
        const path = resolveActivePath(tree, ids.aOld);

        expect(path.slice(0, 3)).toStrictEqual([ids.u1, ids.aOld, toolResultId]);
        expect(path).toHaveLength(5);
        expect(path).not.toContain(ids.aNew);
        expect(path).not.toContain(ids.u2);
        // The other branch is untouched.
        expect(resolveActivePath(tree, ids.aNew)).toStrictEqual([ids.u1, ids.aNew, ids.u2, ids.a2]);
    });
});

describe("forking a branched thread", () => {
    // The displayed path is u1 → aNew → u2 → a2; aOld is an off-path sibling
    // that a raw row index counts and the UI does not show.
    const forkEndOf = async (target: { index?: number; messageId?: string }) =>
        await harness.run(async (ctx: any) => {
            await ctx.db.patch(threadId, { activeLeafMessageId: ids.a2 });
            const end = await ctx.runQuery(resolveForkEnd, { ...target, threadId });

            return end?.endId;
        });

    /** Forks like `branchThread` does, and returns the copy's rows beside the parent context recorded for it. */
    const forkAndRead = async (target: { index?: number; messageId?: string }) =>
        await harness.run(async (ctx: any) => {
            await ctx.db.patch(threadId, { activeLeafMessageId: ids.a2 });
            const copy = await ctx.db.insert("threads", { status: "active", title: "Fork", userId: OWNER });
            const end = await ctx.runQuery(resolveForkEnd, { ...target, threadId });

            await ctx.runMutation(cloneMessageBatch, {
                paginationOpts: { cursor: null, numItems: 100 },
                sourceThreadId: threadId,
                statuses: ["success"],
                targetThreadId: copy,
                upToAndIncludingMessageId: end.endId,
            });

            const rows = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", copy))
                .collect();
            // What `getFullThreadForExport` reads back from the recorded `branchPoint`.
            const contextIds: string[] = await ctx.runQuery(getForkContextIds, { index: end.index, threadId });
            const context = await Promise.all(
                contextIds.map(async (id) => {
                    const row = await ctx.db.get(id);

                    return row.message;
                }),
            );

            return { branchPoint: end.index, context, copied: rows.map((row: any) => row.message) };
        });

    it("forks at the message the user clicked", async () => {
        await expect(forkEndOf({ messageId: ids.a2 as string })).resolves.toBe(ids.a2);
        await expect(forkEndOf({ messageId: ids.aNew as string })).resolves.toBe(ids.aNew);
    });

    it("resolves a legacy index along the displayed path", async () => {
        // Index 3 of the raw rows is u2; on screen it is a2.
        await expect(forkEndOf({ index: 3 })).resolves.toBe(ids.a2);
        await expect(forkEndOf({ index: 1 })).resolves.toBe(ids.aNew);
    });

    it("cuts the parent context exactly where the fork copied", async () => {
        const fork = await forkAndRead({ index: 2 });

        expect(fork.branchPoint).toBe(2);
        expect(fork.copied).toHaveLength(3);
        expect(fork.context).toStrictEqual(fork.copied);
    });

    it("forks the whole displayed path for a thread-level branch", async () => {
        const fork = await forkAndRead({});

        // u1, aNew, u2, a2 — never the off-path aOld.
        expect(fork.branchPoint).toBe(3);
        expect(fork.copied).toHaveLength(4);
        expect(fork.context).toStrictEqual(fork.copied);
    });

    it("refuses a sibling that is not on the displayed path", async () => {
        await expect(forkEndOf({ messageId: ids.aOld as string })).resolves.toBeUndefined();
    });
});

describe("listActivePathPage past 25 rows", () => {
    const readThread = async () => await harness.run(async (ctx: any) => await ctx.db.get(threadId));

    const pageThrough = async (numberItems: number) => {
        const thread = await readThread();
        const collected: string[] = [];
        const branches = new Map<string, unknown>();
        let cursor: string | null = null;

        for (let guard = 0; guard < 100; guard += 1) {
            const page: any = await harness.run(async (ctx: any) => await listActivePathPage(ctx, thread, { cursor, numItems: numberItems }));

            collected.push(...page.page.map((row: { _id: string }) => row._id));

            for (const [id, branch] of page.branches) {
                branches.set(id, branch);
            }

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
        }

        return { branches, collected, thread };
    };

    beforeEach(async () => {
        // A thread of its own; `allRows` reads the whole table, so empty it too.
        await harness.run(async (ctx: any) => {
            const existing = await ctx.db.query("messages").collect();

            for (const row of existing) {
                await ctx.db.delete(row._id);
            }
        });
        threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Long", userId: OWNER }));

        // 20 legacy turns, each a prompt and a two-step reply: 60 rows, no parent ids.
        for (let turn = 0; turn < 20; turn += 1) {
            await insertRow(`u${String(turn)}`, turn, 0, { content: `q${String(turn)}`, role: "user" });
            await insertRow(`a${String(turn)}`, turn, 1, assistantText(`a${String(turn)}`));
            await insertRow(`a${String(turn)}b`, turn, 2, assistantText(`a${String(turn)} more`));
        }

        // Regenerate turn 8, then carry on for 12 turns from the new reply.
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.u8 }));
        await addMessages({ failPendingSteps: true, messages: [{ message: assistantText("a8 again") }], promptMessageId: ids.u8 });

        for (let turn = 0; turn < 12; turn += 1) {
            await addMessages({
                messages: [{ message: { content: `later ${String(turn)}`, role: "user" } }, { message: assistantText(`reply ${String(turn)}`) }],
            });
        }

        // Edit prompt 3 as a sibling (what `saveEditedSibling` stores), and reply.
        const edited = await addMessages({ messages: [{ message: { content: "q3 edited", role: "user" } }], parentMessageId: ids.a2b });

        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: edited.messages[0]?._id }));
        await addMessages({ messages: [{ message: assistantText("a3 edited") }] });
    });

    it("pages the active path exactly as the whole-tree resolution does", async () => {
        const rows = await allRows();
        const tree = buildBranchTree(rows);
        const regeneratedLeaf = (rows as { _id: string; text?: string }[]).find((row) => row.text === "reply 11")?._id;
        const lengths: number[] = [];

        // The edited branch, then the long regenerated one.
        for (const leaf of [undefined, regeneratedLeaf]) {
            if (leaf) {
                await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: leaf }));
            }

            const { branches, collected, thread } = await pageThrough(7);
            const expected = resolveActivePath(tree, thread.activeLeafMessageId).toReversed();

            expect(collected).toStrictEqual(expected);

            for (const id of expected) {
                expect(branches.get(id)).toStrictEqual(branchInfo(tree, id));
            }

            lengths.push(expected.length);
        }

        expect(lengths[0]).toBe(11);
        expect(lengths[1]).toBeGreaterThan(25);
    });

    it("keeps the stored leaf current, so the latest reply ends the path", async () => {
        const { collected } = await pageThrough(10);
        const rows = await allRows();
        const newest = rows.toSorted((a, b) => b.order - a.order || b.stepOrder - a.stepOrder)[0];

        expect(collected[0]).toBe(newest?._id);
        const thread = await readThread();

        expect(thread.activeLeafMessageId).toBe(newest?._id);
    });

    it("follows a switch into an older branch", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.a19b }));

        const { collected } = await pageThrough(9);
        const tree = buildBranchTree(await allRows());

        expect(collected).toStrictEqual(resolveActivePath(tree, ids.a19b).toReversed());
        expect(collected).toHaveLength(60);
    });

    it("grows a pinned first page by the rows added after it", async () => {
        const thread = await readThread();
        const first: any = await harness.run(async (ctx: any) => await listActivePathPage(ctx, thread, { cursor: null, numItems: 5 }));

        await addMessages({ messages: [{ message: { content: "one more", role: "user" } }] });

        const grown = await readThread();
        const pinned: any = await harness.run(
            async (ctx: any) => await listActivePathPage(ctx, grown, { cursor: null, endCursor: first.continueCursor, numItems: 5 }),
        );

        expect(pinned.page).toHaveLength(6);
        expect(pinned.page.slice(1).map((row: { _id: string }) => row._id)).toStrictEqual(first.page.map((row: { _id: string }) => row._id));
        expect(pinned.continueCursor).toBe(first.continueCursor);
    });
});

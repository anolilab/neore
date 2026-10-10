/**
 * An edit's reply whose queue delivery died must not leave the edited prompt
 * silent or spinning: the lapse handler fails its pending rows, or — when none
 * were written — adds a failed reply under the prompt. Never a second one.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { ABANDONED_REPLY_TEXT, failAbandonedEditReply } from "./edit-abandon";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insert = async (table: string, row: Record<string, unknown>): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.insert(table, row));

const rowsOf = async (threadId: string): Promise<any[]> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", threadId))
                .collect(),
    );

const setup = async () => {
    const threadId = await insert("threads", { status: "active", title: "t", userId: "u1" });
    const promptId = await insert("messages", {
        message: { content: "Edited question", role: "user" },
        order: 0,
        status: "success",
        stepOrder: 0,
        text: "Edited question",
        threadId,
        tool: false,
        userId: "u1",
    });

    return { promptId, threadId };
};

const lapse = async (threadId: string, promptMessageId: string) =>
    await harness.run(async (ctx: any) => await ctx.runMutation(failAbandonedEditReply, { claimKey: "job-1", promptMessageId, threadId }));

describe("failAbandonedEditReply", () => {
    it("fails the reply that was still pending", async () => {
        const { promptId, threadId } = await setup();
        const pending = await insert("messages", {
            message: { content: [{ text: "Half an ans", type: "text" }], role: "assistant" },
            order: 0,
            status: "pending",
            stepOrder: 1,
            text: "Half an ans",
            threadId,
            tool: false,
            userId: "u1",
        });

        await expect(lapse(threadId, promptId)).resolves.toStrictEqual({ added: false, failed: 1 });

        const row = await harness.run(async (ctx: any) => await ctx.db.get(pending));

        expect(row).toMatchObject({ status: "failed", text: ABANDONED_REPLY_TEXT });
        expect(await rowsOf(threadId)).toHaveLength(2);
    });

    it("adds a failed reply under the prompt when the delivery died before writing one, and only once", async () => {
        const { promptId, threadId } = await setup();

        await expect(lapse(threadId, promptId)).resolves.toStrictEqual({ added: true, failed: 0 });
        await expect(lapse(threadId, promptId)).resolves.toStrictEqual({ added: false, failed: 0 });

        const rows = await rowsOf(threadId);
        const replies = rows.filter((row) => row.message?.role === "assistant");

        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ order: 0, status: "failed" });
    });
});

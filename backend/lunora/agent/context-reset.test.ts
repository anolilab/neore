/**
 * The divider a fresh-context task run leaves: written under the thread's last row, shown as a
 * divider in the transcript, never sent to a model, and only in the owner's thread.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { appendContextReset } from "./context-reset";
import { CONTEXT_RESET_KEY, contextResetOf } from "./context-reset-shape";
import { docsToModelMessages } from "./mapping";
import { toUIMessages } from "./ui-messages";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const row = (id: string, order: number, message: unknown, extra: Record<string, unknown> = {}) =>
    ({ _creationTime: order, _id: id, message, order, status: "success", stepOrder: 0, threadId: "t1", tool: false, ...extra }) as never;

const resetRow = row("reset", 1, { content: "", role: "system" }, { providerMetadata: { [CONTEXT_RESET_KEY]: { reason: "task_run" } } });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("context reset divider", () => {
    it("is shown as a divider and never sent to a model", () => {
        const earlier = row("a1", 0, { content: "Last week's report", role: "assistant" });
        const prompt = row("u2", 2, { content: "Write this week's report", role: "user" });

        expect(docsToModelMessages([earlier, resetRow, prompt])).toHaveLength(2);

        const messages = toUIMessages([earlier, resetRow, prompt]);

        expect(messages.find((message) => message.id === "reset")?.parts).toStrictEqual([
            { data: { reason: "task_run" }, id: "reset", type: "data-contextReset" },
        ]);
    });

    it("hangs the divider under the displayed leaf of a branched thread, not a newer sibling", async () => {
        const threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Task: report", userId: "owner" }));
        const insertRow = async (order: number, stepOrder: number, parentMessageId?: string): Promise<string> =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("messages", {
                        createdAt: order * 10 + stepOrder,
                        message: { content: `row ${String(order)}.${String(stepOrder)}`, role: order === 0 ? "user" : "assistant" },
                        order,
                        status: "success",
                        stepOrder,
                        threadId,
                        tool: false,
                        userId: "owner",
                        ...(parentMessageId && { parentMessageId }),
                    }),
            );
        const prompt = await insertRow(0, 0);
        const shown = await insertRow(1, 0, prompt);

        // A newer sibling reply, stored after the one on screen.
        await insertRow(1, 1, prompt);
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { activeLeafMessageId: shown }));

        await harness.run(async (ctx: any) => await ctx.runMutation(appendContextReset, { threadId, userId: "owner" }));

        const rows: any[] = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());
        const divider = rows.find((message) => contextResetOf(message));

        expect(divider?.parentMessageId).toBe(shown);
    });

    it("appends the divider to the owner's thread and refuses someone else's", async () => {
        const threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Task: report", userId: "owner" }));

        const run = async (userId: string): Promise<boolean> =>
            await harness.run(async (ctx: any) => await ctx.runMutation(appendContextReset, { threadId, userId }));

        expect(await run("someone-else")).toBe(false);

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: 1 }));
        expect(await run("owner")).toBe(false);
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: null }));
        expect(await run("owner")).toBe(true);

        const rows: any[] = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

        expect(rows).toHaveLength(1);
        expect(contextResetOf(rows[0])).toStrictEqual({ reason: "task_run" });
        expect(rows[0].message).toStrictEqual({ content: "", role: "system" });
    });
});

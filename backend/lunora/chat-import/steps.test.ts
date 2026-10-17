/**
 * The import stamps each thread and message with its SOURCE creation time, and the sidebar
 * page orders by that stored time, so imported history sorts by when it was created.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { insertThread } from "../agent/table-writes";
import { getThreadListDataBatchHandler } from "../agent/threads";
import schema from "../schema";
import { processConversationBatch } from "./steps";

const USER = "user-import";
const DAY = 86_400_000;

describe("processConversationBatch createdAt", () => {
    it("stores the source times and orders the sidebar page by them", async () => {
        const harness = lunoraTest(schema as never);
        const old = Date.now() - 400 * DAY;
        const older = Date.now() - 800 * DAY;

        const result = (await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(processConversationBatch, {
                    conversations: [
                        // Imported FIRST but created before `old`: it must sort below it.
                        {
                            createdAt: older,
                            messages: [
                                { content: "hi", createdAt: older + 5, role: "user" },
                                { content: "yo", role: "assistant" },
                            ],
                            title: "older",
                        },
                        { createdAt: old, messages: [{ content: "hi", createdAt: old, role: "user" }], title: "old" },
                        // No source time: falls back to the import time.
                        { messages: [{ content: "hi", role: "user" }], title: "undated" },
                    ],
                    provider: "chatgpt",
                    userId: USER,
                }),
        )) as { failed: number; imported: number };

        expect(result).toEqual({ failed: 0, imported: 3 });

        // A thread the app created after the import, and a legacy row with no createdAt.
        await harness.run(async (context: any) => {
            await insertThread(context.db, { status: "active", title: "new", userId: USER });
            await context.db.insert("threads", { status: "active", title: "legacy", userId: USER });
        });

        const { list, rows } = await harness.run(async (context: any) => {
            const page = await getThreadListDataBatchHandler(context, { userId: USER });
            const threads = await context.db.threads.findMany({ where: { userId: USER } });
            const messages = await context.db.messages.findMany({ where: { userId: USER } });

            return { list: page.threads.page, rows: { messages: messages.page, threads: threads.page } };
        });

        const byTitle = new Map(rows.threads.map((thread: any) => [thread.title, thread]));

        expect((byTitle.get("older") as any).createdAt).toBe(older);
        expect((byTitle.get("old") as any).createdAt).toBe(old);
        expect(typeof (byTitle.get("undated") as any).createdAt).toBe("number");
        expect((byTitle.get("legacy") as any).createdAt).toBeUndefined();

        const messageTimes = rows.messages.map((message: any) => message.createdAt);

        expect(messageTimes).toContain(older + 5);
        expect(messageTimes.every((time: unknown) => typeof time === "number")).toBe(true);

        // Stamped rows newest-created first, the older imports by their source time, then the
        // unstamped legacy row.
        const titles = list.map((thread: any) => thread.title);

        expect(titles.indexOf("old")).toBeLessThan(titles.indexOf("older"));
        expect(titles.indexOf("new")).toBeLessThan(titles.indexOf("old"));
        expect(titles.indexOf("undated")).toBeLessThan(titles.indexOf("old"));
        expect(titles.indexOf("older")).toBeLessThan(titles.indexOf("legacy"));
    });
});

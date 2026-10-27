/**
 * The read behind a quiet routine's decision: timestamps survive, and other
 * routines' notifications are left out of the read itself so they cannot fill its limit.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addMessagesHandler } from "../agent/messages";
import schema from "../schema";
import { isQuietRunSkipped } from "./quiet";
import { loadQuietSnapshot } from "./quiet-inputs";

const USER = "user-a";
const NOW = Date.UTC(2026, 8, 25, 7, 30);

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const snapshotSince = async (since: number) =>
    await harness.run(
        async (ctx: any) =>
            await (loadQuietSnapshot as unknown as { handler: (ctx: unknown, args: unknown) => Promise<any> }).handler(ctx, { since, userId: USER }),
    );

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("loadQuietSnapshot", () => {
    it("leaves out other routines' notifications and the brief, and finds a real event behind a flood of them", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("notifications", { createdAt: NOW - 10_000, title: "Eval done", type: "eval", userId: USER });

            for (let index = 0; index < 60; index += 1) {
                await ctx.db.insert("notifications", { createdAt: NOW - index, title: `Run ${String(index)}`, type: "trigger", userId: USER });
            }

            await ctx.db.insert("notifications", { createdAt: NOW, title: "Brief", type: "daily_brief", userId: USER });
        });

        const { events } = await snapshotSince(NOW - 60_000);

        expect(events).toEqual([{ createdAt: NOW - 10_000, type: "eval" }]);
    });

    it("reads only notifications newer than the window start", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("notifications", { createdAt: NOW - 120_000, title: "Old", type: "task", userId: USER });
        });

        const { events } = await snapshotSince(NOW - 60_000);

        expect(events).toEqual([]);
    });

    it("keeps the time of a task that needs review, a running task and a thread", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threads", { status: "regular", title: "Planning", updatedAt: NOW - 5000, userId: USER });
            await ctx.db.insert("tasks", { createdAt: 1, status: "needs_review", title: "Review me", updatedAt: NOW - 4000, userId: USER });
            await ctx.db.insert("tasks", { createdAt: 1, status: "running", title: "Sync", updatedAt: NOW - 3000, userId: USER });
        });

        const snapshot = await snapshotSince(NOW - 60_000);

        expect(snapshot.threads).toEqual([{ title: "Planning", updatedAt: NOW - 5000 }]);
        expect(snapshot.needsYou).toEqual([{ at: NOW - 4000, kind: "task_review", title: "Review me" }]);
        expect(snapshot.running).toEqual([{ at: NOW - 3000, kind: "task", title: "Sync" }]);
    });

    it("leaves out a routine's run thread by its tag and keeps a chat only titled like one", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threads", { status: "active", tags: ["trigger"], title: "Trigger: Digest", updatedAt: NOW - 1000, userId: USER });
            await ctx.db.insert("threads", { status: "active", title: "Trigger: x", updatedAt: NOW - 2000, userId: USER });
        });

        const { threads } = await snapshotSince(NOW - 60_000);

        expect(threads).toEqual([{ title: "Trigger: x", updatedAt: NOW - 2000 }]);
    });

    describe("a reply in a routine's run thread", () => {
        const insertRunThread = async (extra: Record<string, unknown> = {}, title = "Trigger: Digest") =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("threads", { status: "active", tags: ["trigger"], title, updatedAt: NOW - 500, userId: USER, ...extra }),
            );

        const save = async (threadId: string, role: "assistant" | "user") =>
            await harness.run(async (ctx: any) => {
                await addMessagesHandler(ctx, { messages: [{ message: { content: "text", role } }], threadId: threadId as never, userId: USER });
            });

        it("does not count the run's own prompt and answer", async () => {
            const threadId = await insertRunThread({ updatedAt: NOW - 120_000 });

            await save(threadId, "user");
            await save(threadId, "assistant");

            const { threads } = await snapshotSince(NOW - 60_000);

            expect(threads).toEqual([]);
            const row = await harness.run(async (ctx: any) => await ctx.db.threads.findFirst({ where: { _id: threadId } }));

            expect(row.lastUserMessageAt).toBeUndefined();
        });

        it("counts a reply saved through the message write even when no stream ever starts", async () => {
            const threadId = await insertRunThread({ updatedAt: NOW - 120_000 });

            await save(threadId, "user");
            await save(threadId, "assistant");
            // Only the save: `createStreamWithMessage` (the later `updatedAt` bump) never runs.
            await save(threadId, "user");

            const { threads } = await snapshotSince(NOW - 60_000);

            expect(threads).toHaveLength(1);
            expect(threads[0]?.title).toBe("Trigger: Digest");
        });

        it("does not count a reply from before the window start", async () => {
            await insertRunThread({ lastUserMessageAt: NOW - 120_000 });

            const { threads } = await snapshotSince(NOW - 60_000);

            expect(threads).toEqual([]);
        });

        it("dates the activity by the reply and finds it behind more newer run threads than the limit", async () => {
            await insertRunThread({ lastUserMessageAt: NOW - 2000 });

            await harness.run(async (ctx: any) => {
                for (let index = 0; index < 25; index += 1) {
                    await ctx.db.insert("threads", {
                        status: "active",
                        tags: ["trigger"],
                        title: `Trigger: Other ${String(index)}`,
                        updatedAt: NOW - 400 + index,
                        userId: USER,
                    });
                }
            });

            const { threads } = await snapshotSince(NOW - 60_000);

            expect(threads).toEqual([{ title: "Trigger: Digest", updatedAt: NOW - 2000 }]);
        });

        it("does not read as activity when many run threads were updated and nobody replied", async () => {
            await harness.run(async (ctx: any) => {
                for (let index = 0; index < 120; index += 1) {
                    await ctx.db.insert("threads", {
                        status: "active",
                        tags: ["trigger"],
                        title: `Trigger: Other ${String(index)}`,
                        updatedAt: NOW - 400 + index,
                        userId: USER,
                    });
                }
            });

            const snapshot = await snapshotSince(NOW - 60_000);

            expect(snapshot.threads).toEqual([]);
            expect(
                await isQuietRunSkipped(
                    { botId: "bot-a", createdAt: 1, lastTriggeredAt: NOW - 60_000, quietWhenEmpty: true, type: "schedule" },
                    snapshotSince,
                    { manual: false },
                ),
            ).toBe(true);
        });
    });

    it("still counts a chat when more routine threads than the home view keeps were updated after it", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threads", { status: "active", title: "Planning", updatedAt: NOW - 50_000, userId: USER });

            for (let index = 0; index < 30; index += 1) {
                await ctx.db.insert("threads", {
                    status: "active",
                    tags: ["trigger"],
                    title: `Trigger: Run ${String(index)}`,
                    updatedAt: NOW - index,
                    userId: USER,
                });
                await ctx.db.insert("threads", {
                    isTemporary: true,
                    status: "active",
                    title: `Scratch ${String(index)}`,
                    updatedAt: NOW - index,
                    userId: USER,
                });
            }
        });

        const { threads } = await snapshotSince(NOW - 60_000);

        expect(threads).toEqual([{ title: "Planning", updatedAt: NOW - 50_000 }]);
    });

    it("still counts a titled chat when more untitled threads than the limit were updated after it", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threads", { status: "active", title: "Planning", updatedAt: NOW - 50_000, userId: USER });

            for (let index = 0; index < 25; index += 1) {
                await ctx.db.insert("threads", { status: "active", title: "", updatedAt: NOW - index, userId: USER });
                await ctx.db.insert("threads", { status: "active", updatedAt: NOW - index, userId: USER });
            }
        });

        const { threads } = await snapshotSince(NOW - 60_000);

        expect(threads).toEqual([{ title: "Planning", updatedAt: NOW - 50_000 }]);
    });

    it("reads only live, unlocked, titled chats of the user from inside the window", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threads", { status: "active", title: "Old", updatedAt: NOW - 120_000, userId: USER });
            await ctx.db.insert("threads", { deleted: true, status: "active", title: "Deleted", updatedAt: NOW - 1000, userId: USER });
            await ctx.db.insert("threads", { lockedAt: NOW - 5000, status: "active", title: "Locked", updatedAt: NOW - 1000, userId: USER });
            await ctx.db.insert("threads", { status: "active", updatedAt: NOW - 1000, userId: USER });
            await ctx.db.insert("threads", { status: "active", title: "Someone else's", updatedAt: NOW - 1000, userId: "user-b" });
            await ctx.db.insert("threads", { deleted: false, status: "active", tags: ["chat"], title: "Kept", updatedAt: NOW - 2000, userId: USER });
        });

        const { threads } = await snapshotSince(NOW - 60_000);

        expect(threads).toEqual([{ title: "Kept", updatedAt: NOW - 2000 }]);
    });

    it("dates a chat that has no updatedAt by its creation", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threads", { status: "active", title: "Legacy", userId: USER });
        });

        // The row's creation is the real clock: inside a window that began before it, outside one that begins after it.
        const inside = await snapshotSince(Date.now() - 60_000);
        const outside = await snapshotSince(Date.now() + 60_000);

        expect(inside.threads.map((thread: { title: string }) => thread.title)).toEqual(["Legacy"]);
        expect(outside.threads).toEqual([]);
    });

    describe("a task that finished inside the window", () => {
        const SINCE = NOW - 60_000;
        const ROUTINE = { botId: "bot-a", createdAt: 1, lastTriggeredAt: SINCE, quietWhenEmpty: true, type: "schedule" } as const;
        const SCHEDULED = { manual: false };

        const skipped = async () => await isQuietRunSkipped(ROUTINE, snapshotSince, SCHEDULED);

        it("makes the next quiet check post, with no notification and no chat", async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("tasks", { createdAt: 1, status: "done", title: "Shipped", updatedAt: SINCE + 1000, userId: USER });
            });

            await expect(skipped()).resolves.toBe(false);
        });

        it("does not, when it was last updated before the window start", async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("tasks", { createdAt: 1, status: "done", title: "Old", updatedAt: SINCE - 1000, userId: USER });
            });

            await expect(skipped()).resolves.toBe(true);
        });

        it("does not, when it is another user's", async () => {
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("tasks", { createdAt: 1, status: "done", title: "Theirs", updatedAt: SINCE + 1000, userId: "user-b" });
            });

            await expect(skipped()).resolves.toBe(true);
        });
    });
});

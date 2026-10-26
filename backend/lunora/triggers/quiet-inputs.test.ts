/**
 * The read behind a quiet routine's decision: timestamps survive, and other
 * routines' notifications are left out of the read itself so they cannot fill its limit.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
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
});

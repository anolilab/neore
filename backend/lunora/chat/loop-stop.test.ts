/**
 * The closing line of a turn the repeated-call guard ended is written only for a thread the owner can still write to: never a
 * locked, deleted or foreign thread, and never under a reply that is no longer the active leaf.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { appendLoopStopNoticeRow } from "./loop-stop";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let OWNER = "";
let STRANGER = "";

const seedUser = async (name: string) =>
    (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: `${name}@example.com`, emailVerified: true, name, updatedAt: 0 }),
    )) as string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    OWNER = await seedUser("owner");
    STRANGER = await seedUser("stranger");
});

afterEach(() => {
    harness.close();
});

const seedThread = async (extra: Record<string, unknown> = {}) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "Inbox", userId: OWNER, ...extra }))) as string;

const write = async (threadId: string, userId = OWNER) =>
    await harness.run(
        async (ctx: any) =>
            await appendLoopStopNoticeRow(ctx, { notice: "I stopped this reply.", replyRowId: "missing-row", threadId: threadId as never, userId }),
    );

const assistantRowsOf = async (threadId: string) =>
    await harness.run(async (ctx: any) => {
        const rows: { message?: { role?: string }; threadId?: string }[] = await ctx.db.query("messages").collect();

        return rows.filter((row) => row.threadId === threadId && row.message?.role === "assistant");
    });

describe("writing the closing line of a stopped loop", () => {
    it("writes nothing into a locked thread", async () => {
        const threadId = await seedThread({ lockedAt: 1 });

        expect(await write(threadId)).toBe(false);
        expect(await assistantRowsOf(threadId)).toStrictEqual([]);
    });

    it("writes nothing into a deleted thread", async () => {
        const threadId = await seedThread({ deleted: true });

        expect(await write(threadId)).toBe(false);
        expect(await assistantRowsOf(threadId)).toStrictEqual([]);
    });

    it("writes nothing into another user's thread", async () => {
        const threadId = await seedThread();

        expect(await write(threadId, STRANGER)).toBe(false);
        expect(await assistantRowsOf(threadId)).toStrictEqual([]);
    });

    it("writes nothing when the reply is not the thread's active leaf", async () => {
        const threadId = await seedThread();

        expect(await write(threadId)).toBe(false);
        expect(await assistantRowsOf(threadId)).toStrictEqual([]);
    });
});

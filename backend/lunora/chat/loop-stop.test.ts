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

/** An assistant reply row on the thread, at `order`, as a run saves it. Returns its id. */
const seedReply = async (threadId: string, order: number) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: { content: [{ text: "Here is the answer.", type: "text" }], role: "assistant" },
                order,
                status: "success",
                stepOrder: 0,
                text: "Here is the answer.",
                threadId,
                userId: OWNER,
            }),
    )) as string;

/** Makes `replyId` the thread's active leaf, as a reply that landed on the active path does. */
const makeLeaf = async (threadId: string, replyId: string) =>
    await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { activeLeafMessageId: replyId }));

const write = async (threadId: string, replyRowId: string, userId = OWNER) =>
    await harness.run(
        async (ctx: any) => await appendLoopStopNoticeRow(ctx, { notice: "I stopped this reply.", replyRowId, threadId: threadId as never, userId }),
    );

const assistantRowsOf = async (threadId: string) =>
    await harness.run(async (ctx: any) => {
        const rows: { message?: { role?: string }; threadId?: string }[] = await ctx.db.query("messages").collect();

        return rows.filter((row) => row.threadId === threadId && row.message?.role === "assistant");
    });

describe("writing the closing line of a stopped loop", () => {
    it("writes the line under the last reply of a thread that never branched", async () => {
        const threadId = await seedThread();
        const reply = await seedReply(threadId, 1);

        expect(await write(threadId, reply)).toBe(true);
        expect(await assistantRowsOf(threadId)).toHaveLength(2);
    });

    it("writes nothing into a locked thread, whose reply is the active leaf", async () => {
        const threadId = await seedThread({ lockedAt: 1 });
        const reply = await seedReply(threadId, 1);

        await makeLeaf(threadId, reply);

        expect(await write(threadId, reply)).toBe(false);
        expect(await assistantRowsOf(threadId)).toHaveLength(1);
    });

    it("writes nothing into a deleted thread, whose reply is the active leaf", async () => {
        const threadId = await seedThread({ deleted: true });
        const reply = await seedReply(threadId, 1);

        await makeLeaf(threadId, reply);

        expect(await write(threadId, reply)).toBe(false);
        expect(await assistantRowsOf(threadId)).toHaveLength(1);
    });

    it("writes nothing into another user's thread, whose reply is the active leaf", async () => {
        const threadId = await seedThread();
        const reply = await seedReply(threadId, 1);

        await makeLeaf(threadId, reply);

        expect(await write(threadId, reply, STRANGER)).toBe(false);
        expect(await assistantRowsOf(threadId)).toHaveLength(1);
    });

    it("writes nothing when the reply is not the thread's active leaf", async () => {
        const threadId = await seedThread();
        const first = await seedReply(threadId, 1);
        const second = await seedReply(threadId, 2);

        await makeLeaf(threadId, second);

        expect(await write(threadId, first)).toBe(false);
        expect(await assistantRowsOf(threadId)).toHaveLength(2);
    });
});

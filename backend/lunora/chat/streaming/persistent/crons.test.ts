/**
 * The expiry sweep turns an expired pending or streaming stream into `timeout`. A finished stream is never
 * revisited, and a stream that has not expired yet is left as it is. Finished streams are never deleted, so the
 * sweep must not read them: the cost test below pins the rows it reads.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureDb } from "../../../../test/db-cost";
import schema from "../../../schema";
import { cleanupExpiredStreams } from "./crons";

const OWNER = "user-owner";
const HOUR = 60 * 60 * 1000;
const FINISHED = 50;

let harness: ReturnType<typeof lunoraTest>;

interface Thread {
    messageId: string;
    threadId: string;
}

const seedThread = async (): Promise<Thread> =>
    await harness.run(async (context) => {
        const threadId = await context.db.insert("threads", { model: "m", status: "running", title: "t", userId: OWNER });
        const messageId = await context.db.insert("messages", {
            message: { content: "hi", role: "user" },
            order: 1,
            status: "success",
            stepOrder: 0,
            text: "hi",
            threadId,
            tool: false,
            userId: OWNER,
        });

        return { messageId, threadId };
    });

const insertStreams = async (thread: Thread, status: string, expiresAt: number, count: number): Promise<void> =>
    await harness.run(async (context) => {
        for (let index = 0; index < count; index += 1) {
            await context.db.insert("persistentStreams", {
                expiresAt,
                messageId: thread.messageId,
                status,
                streamingConfig: { contentType: "text", model: "m" },
                threadId: thread.threadId,
                userId: OWNER,
            });
        }
    });

const insertStream = async (thread: Thread, status: string, expiresAt: number): Promise<string> =>
    await harness.run(
        async (context) =>
            await context.db.insert("persistentStreams", {
                expiresAt,
                messageId: thread.messageId,
                status,
                streamingConfig: { contentType: "text", model: "m" },
                threadId: thread.threadId,
                userId: OWNER,
            }),
    );

const sweep = async () => await harness.run(async (context) => await context.runMutation(cleanupExpiredStreams, {}));

const statusOf = async (id: string): Promise<unknown> =>
    await harness.run(async (context) => ((await context.db.get(id as never)) as { status?: unknown } | null)?.status);

describe("cleanupExpiredStreams", () => {
    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("times out an expired pending or streaming stream", async () => {
        expect.assertions(2);

        const thread = await seedThread();
        const pending = await insertStream(thread, "pending", Date.now() - HOUR);
        const streaming = await insertStream(thread, "streaming", Date.now() - HOUR);

        await sweep();

        await expect(statusOf(pending)).resolves.toBe("timeout");
        await expect(statusOf(streaming)).resolves.toBe("timeout");
    });

    it("leaves a finished stream alone, even when it is past its expiry", async () => {
        expect.assertions(1);

        const thread = await seedThread();
        const done = await insertStream(thread, "done", Date.now() - HOUR);

        await sweep();

        await expect(statusOf(done)).resolves.toBe("done");
    });

    it("leaves a stream that has not expired yet alone", async () => {
        expect.assertions(1);

        const thread = await seedThread();
        const live = await insertStream(thread, "streaming", Date.now() + HOUR);

        await sweep();

        await expect(statusOf(live)).resolves.toBe("streaming");
    });

    it("reads only the live rows, not the finished streams the table has accumulated", async () => {
        expect.assertions(2);

        const thread = await seedThread();

        await insertStreams(thread, "done", Date.now() - HOUR, FINISHED);
        const pending = await insertStream(thread, "pending", Date.now() - HOUR);

        const { cost } = await measureDb(sweep);

        // Each expired finished stream would be one row read on the old `by_expiresAt` walk.
        expect(cost.rowsRead).toBeLessThan(FINISHED / 5);
        await expect(statusOf(pending)).resolves.toBe("timeout");
    });
});

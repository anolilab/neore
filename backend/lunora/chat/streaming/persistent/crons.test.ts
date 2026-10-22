/**
 * A run that dies without reaching `failRun` leaves its thread `running`. When the
 * stream expires, the cleanup cron hands the thread back, unless a newer stream
 * on it is still live.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../../../schema";
import { cleanupExpiredStreams } from "./crons";

const OWNER = "user-owner";

let harness: ReturnType<typeof lunoraTest>;

const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

const insertStream = async (threadId: string, status: string, expiresAt: number): Promise<string> =>
    await run(
        async (context) =>
            await context.db.insert("persistentStreams", {
                expiresAt,
                messageId: "m-1",
                status,
                streamingConfig: { contentType: "text", model: "m" },
                threadId,
                userId: OWNER,
            }),
    );

const insertThread = async (status: string): Promise<string> =>
    await run(async (context) => await context.db.insert("threads", { model: "m", status, title: "t", userId: OWNER }));

const cleanup = async (): Promise<void> => {
    await run(async (context) => await context.runMutation(cleanupExpiredStreams, {}));
};

const statusOf = async (id: string): Promise<string> =>
    await run(async (context) => {
        const row = await context.db.get(id);

        return row.status;
    });

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
});

describe("cleanupExpiredStreams", () => {
    it("times out an expired stream and hands its running thread back", async () => {
        const threadId = await insertThread("running");
        const streamId = await insertStream(threadId, "streaming", Date.now() - 1000);

        await cleanup();

        expect(await statusOf(streamId)).toBe("timeout");
        expect(await statusOf(threadId)).toBe("active");
    });

    it("leaves a thread that is not running as it is", async () => {
        const threadId = await insertThread("active");
        const streamId = await insertStream(threadId, "streaming", Date.now() - 1000);

        await cleanup();

        expect(await statusOf(streamId)).toBe("timeout");
        expect(await statusOf(threadId)).toBe("active");
    });

    it("leaves the thread running while a newer stream on it is live", async () => {
        const threadId = await insertThread("running");
        const expired = await insertStream(threadId, "streaming", Date.now() - 1000);

        await insertStream(threadId, "streaming", Date.now() + 60_000);

        await cleanup();

        expect(await statusOf(expired)).toBe("timeout");
        expect(await statusOf(threadId)).toBe("running");
    });

    it("leaves the thread running while an edit streams on it, which uses streamingMessages instead", async () => {
        const threadId = await insertThread("running");
        const expired = await insertStream(threadId, "streaming", Date.now() - 1000);

        await run(
            async (context) =>
                await context.db.insert("streamingMessages", {
                    order: 1,
                    state: { kind: "streaming", lastHeartbeat: Date.now() },
                    stateKind: "streaming",
                    stepOrder: 0,
                    threadId,
                    userId: OWNER,
                }),
        );

        await cleanup();

        expect(await statusOf(expired)).toBe("timeout");
        expect(await statusOf(threadId)).toBe("running");
    });
});

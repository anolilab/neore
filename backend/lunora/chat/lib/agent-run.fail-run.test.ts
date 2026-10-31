/**
 * A run that fails after its stream was ended elsewhere (the sidebar's stop) writes
 * no error line and leaves the thread `active`, not `error`. A live stream still
 * gets the error line and the thread's requested status.
 */
import { describe, expect, it, vi } from "vitest";

import { LunoraError } from "lunorash/server";

import { internal } from "../../_generated/internal";
import { failRun } from "./agent-run";

const ARGS = { safeMessage: "boom", streamId: "stream-1", threadId: "thread-1", threadStatus: "error" as const };

/**
 * A fake action context. The stream's status reads answer `statuses` in turn (the last one repeats); the chunk write
 * fails with `writeError` when it is set. Every mutation is recorded.
 */
const fakeCtx = (statuses: (string | Error)[], writeError?: Error) => {
    const calls: { args: Record<string, unknown>; ref: unknown }[] = [];
    let reads = 0;
    const ctx = {
        runMutation: async (ref: unknown, args: Record<string, unknown>) => {
            calls.push({ args, ref });

            if (writeError && ref === internal.chat.streaming.persistent.library.addChunk) {
                throw writeError;
            }
        },
        runQuery: async (ref: unknown) => {
            if (ref !== internal.chat.streaming.persistent.library.getStreamStatus) {
                throw new Error("unexpected query");
            }

            const status = statuses[Math.min(reads, statuses.length - 1)];

            reads += 1;

            if (status instanceof Error) {
                throw status;
            }

            return status;
        },
    };

    return { calls, ctx };
};

describe(failRun, () => {
    it("stamps the run's auto-approved calls once the run is closed, even for a stream a stop ended", async () => {
        const { calls, ctx } = fakeCtx(["done"]);
        const stamp = vi.fn(async () => {
            calls.push({ args: {}, ref: "stamp" });
        });

        await failRun(ctx as never, { ...ARGS, stamp });

        expect(stamp).toHaveBeenCalledOnce();
        expect(calls.at(-1)?.ref).toBe("stamp");
    });

    it("does not let a failing stamp undo the close", async () => {
        const { calls, ctx } = fakeCtx(["streaming"]);

        await expect(
            failRun(ctx as never, {
                ...ARGS,
                stamp: async () => {
                    throw new Error("label write failed");
                },
            }),
        ).resolves.toBeUndefined();
        expect(calls.find((call) => call.ref === internal.agent.threads.updateThread)?.args).toMatchObject({ patch: { status: "error" } });
    });

    it("drops the thread's saved secret references, whichever way the stream ended", async () => {
        for (const statuses of [["done"], ["streaming"]]) {
            const { calls, ctx } = fakeCtx(statuses);

            await failRun(ctx as never, ARGS);

            expect(calls.find((call) => call.ref === internal.chat.request_secret.discardSecretsOfThread)?.args).toStrictEqual({
                streamId: "stream-1",
                threadId: "thread-1",
            });
        }
    });

    it("writes no error line and leaves the thread active when the stream was already ended", async () => {
        const { calls, ctx } = fakeCtx(["done"]);

        await failRun(ctx as never, ARGS);

        expect(calls.some((call) => call.ref === internal.chat.streaming.persistent.library.addChunk)).toBe(false);
        expect(calls.find((call) => call.ref === internal.agent.threads.updateThread)?.args).toMatchObject({ patch: { status: "active" } });
    });

    it("settles the stop of a stopped run, which will never save the text it owed", async () => {
        const { calls, ctx } = fakeCtx(["done"]);

        await failRun(ctx as never, ARGS);

        expect(calls.find((call) => call.ref === internal.chat.streaming.persistent.library.settleStoppedRun)?.args).toStrictEqual({ streamId: "stream-1" });
    });

    it("leaves a live stream's stop alone", async () => {
        const { calls, ctx } = fakeCtx(["streaming"]);

        await failRun(ctx as never, ARGS);

        expect(calls.some((call) => call.ref === internal.chat.streaming.persistent.library.settleStoppedRun)).toBe(false);
    });

    it("writes the error line and the requested thread status for a live stream", async () => {
        const { calls, ctx } = fakeCtx(["streaming"]);

        await failRun(ctx as never, ARGS);

        expect(calls.find((call) => call.ref === internal.chat.streaming.persistent.library.addChunk)?.args).toMatchObject({
            final: true,
            text: "\n\nError: boom",
        });
        expect(calls.find((call) => call.ref === internal.agent.threads.updateThread)?.args).toMatchObject({ patch: { status: "error" } });
    });

    it("treats an unreadable stream status as live", async () => {
        const { calls, ctx } = fakeCtx([new Error("read failed")]);

        await failRun(ctx as never, ARGS);

        expect(calls.some((call) => call.ref === internal.chat.streaming.persistent.library.addChunk)).toBe(true);
    });

    it("a stop that lands between the status read and the write ends the run without an error status", async () => {
        // The stop ends the stream after the read, so the write is refused as `done`.
        const { calls, ctx } = fakeCtx(["streaming", "done"], new LunoraError("CONFLICT", "Stream is not streaming"));

        await failRun(ctx as never, ARGS);

        expect(calls.some((call) => call.ref === internal.chat.streaming.persistent.library.setStreamStatus)).toBe(false);
        expect(calls.find((call) => call.ref === internal.agent.threads.updateThread)?.args).toMatchObject({ patch: { status: "active" } });
    });

    it("a genuine write failure still marks the stream and the thread as errored", async () => {
        const { calls, ctx } = fakeCtx(["streaming", "streaming"], new Error("database down"));

        await failRun(ctx as never, ARGS);

        expect(calls.find((call) => call.ref === internal.chat.streaming.persistent.library.setStreamStatus)?.args).toMatchObject({ status: "error" });
        expect(calls.find((call) => call.ref === internal.agent.threads.updateThread)?.args).toMatchObject({ patch: { status: "error" } });
    });
});

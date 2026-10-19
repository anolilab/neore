/**
 * A run that fails after its stream was ended elsewhere (the sidebar's stop) writes
 * no error line and leaves the thread `active`, not `error`. A live stream still
 * gets the error line and the thread's requested status.
 */
import { describe, expect, it } from "vitest";

import { internal } from "../../_generated/internal";
import { failRun } from "./agent-run";

const ARGS = { safeMessage: "boom", streamId: "stream-1", threadId: "thread-1", threadStatus: "error" as const };

/** A fake action context: `streamStatus` answers the stream's status read; every mutation is recorded. */
const fakeCtx = (streamStatus: string | Error) => {
    const calls: { args: Record<string, unknown>; ref: unknown }[] = [];
    const ctx = {
        runMutation: async (ref: unknown, args: Record<string, unknown>) => {
            calls.push({ args, ref });
        },
        runQuery: async (ref: unknown) => {
            if (ref !== internal.chat.streaming.persistent.library.getStreamStatus) {
                throw new Error("unexpected query");
            }

            if (streamStatus instanceof Error) {
                throw streamStatus;
            }

            return streamStatus;
        },
    };

    return { calls, ctx };
};

describe(failRun, () => {
    it("writes no error line and leaves the thread active when the stream was already ended", async () => {
        const { calls, ctx } = fakeCtx("done");

        await failRun(ctx as never, ARGS);

        expect(calls.some((call) => call.ref === internal.chat.streaming.persistent.library.addChunk)).toBe(false);
        expect(calls.find((call) => call.ref === internal.agent.threads.updateThread)?.args).toMatchObject({ patch: { status: "active" } });
    });

    it("writes the error line and the requested thread status for a live stream", async () => {
        const { calls, ctx } = fakeCtx("streaming");

        await failRun(ctx as never, ARGS);

        expect(calls.find((call) => call.ref === internal.chat.streaming.persistent.library.addChunk)?.args).toMatchObject({
            final: true,
            text: "\n\nError: boom",
        });
        expect(calls.find((call) => call.ref === internal.agent.threads.updateThread)?.args).toMatchObject({ patch: { status: "error" } });
    });

    it("treats an unreadable stream status as live", async () => {
        const { calls, ctx } = fakeCtx(new Error("read failed"));

        await failRun(ctx as never, ARGS);

        expect(calls.some((call) => call.ref === internal.chat.streaming.persistent.library.addChunk)).toBe(true);
    });
});

/**
 * The host guide's finalizer is queued only after the turn-ending mutation commits: a queue send is not part of the
 * transaction, so it is scheduled (which commits with the mutation) rather than sent from inside it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../lib/job-queue", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/job-queue")>()), enqueueJob: enqueue };
});

const { settleHostGuide } = await import("./guide-host-end");

const contextWith = (status: string) => {
    return {
        db: {
            pullRequestGuides: {
                findFirst: vi.fn(async () => {
                    return { _id: "guide-1", status };
                }),
            },
        },
        scheduler: { runAfter: vi.fn(async (_delay: number, _target: unknown, _args: unknown, _options: unknown) => "job-1") },
    };
};

describe("settleHostGuide", () => {
    beforeEach(() => {
        enqueue.mockClear();
    });

    it("schedules the finalizer to be queued after the commit, and sends nothing to the queue from the transaction", async () => {
        const ctx = contextWith("generating");

        await settleHostGuide(ctx as never, { _id: "stream-1", threadId: "thread-1", userId: "user-1" } as never, "finished");

        expect(enqueue).not.toHaveBeenCalled();
        expect(ctx.scheduler.runAfter).toHaveBeenCalledOnce();
        expect(ctx.scheduler.runAfter.mock.calls[0]?.[0]).toBe(0);
    });
});

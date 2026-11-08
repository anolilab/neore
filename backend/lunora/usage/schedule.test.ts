import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUserShard, runAfterOnShard, servesUser } = vi.hoisted(() => {
    return {
        currentUserShard: vi.fn((): string | undefined => undefined),
        runAfterOnShard: vi.fn(async () => null),
        servesUser: vi.fn(() => false),
    };
});

vi.mock("../lib/shard-context", async (importOriginal) => {
    return { ...(await importOriginal<object>()), currentUserShard, servesUser };
});
vi.mock("../lib/shard-scheduler", () => {
    return { runAfterOnShard };
});

const { internal } = await import("../_generated/internal");
const { scheduleReplyUsage } = await import("./schedule");

const ARGS = { at: 1, costMicrodollars: 5, date: "2026-09-20", replyKey: "aside:1", skillKey: "__assistant__", threadId: "t1", tokens: 1, userId: "u1" };

describe("scheduleReplyUsage", () => {
    const runAfter = vi.fn(async () => null);

    beforeEach(() => {
        currentUserShard.mockReturnValue(undefined);
        servesUser.mockReturnValue(false);
        runAfter.mockClear();
        runAfterOnShard.mockClear();
    });

    it("sends a record with no thread to the user's shard, even from an action with no shard of its own", () => {
        const noThread = { ...ARGS, threadId: undefined };

        scheduleReplyUsage({ runAfter } as never, noThread);

        expect(runAfter).not.toHaveBeenCalled();
        expect(runAfterOnShard).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, internal.usage.activity.recordReplyUsage, noThread, "u1");
    });

    it("forwards a record with only a thread id through this shard, which holds the thread", () => {
        currentUserShard.mockReturnValue("owner");
        scheduleReplyUsage({ runAfter } as never, ARGS);

        expect(runAfter).toHaveBeenCalledExactlyOnceWith(0, internal.usage.activity.forwardReplyUsage, ARGS);
        expect(runAfterOnShard).not.toHaveBeenCalled();
    });

    it("records on the user's own shard with one job, and books nothing more", () => {
        servesUser.mockReturnValue(true);
        scheduleReplyUsage({ runAfter } as never, ARGS);

        expect(runAfter).toHaveBeenCalledExactlyOnceWith(0, internal.usage.activity.recordReplyUsage, ARGS);
        expect(runAfterOnShard).not.toHaveBeenCalled();
    });
});

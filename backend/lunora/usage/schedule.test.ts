import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAfterOnShard, servesUser } = vi.hoisted(() => {
    return { runAfterOnShard: vi.fn(async () => null), servesUser: vi.fn(() => false) };
});

vi.mock("../lib/shard-context", async (importOriginal) => {
    return { ...(await importOriginal<object>()), servesUser };
});
vi.mock("../lib/shard-scheduler", () => {
    return { runAfterOnShard };
});

const { internal } = await import("../_generated/internal");
const { scheduleReplyUsage } = await import("./schedule");

const ARGS = { at: 1, costMicrodollars: 5, date: "2026-09-20", replyKey: "aside:1", skillKey: "__assistant__", threadId: "t1", tokens: 1, userId: "u1" };

describe("scheduleReplyUsage off the user's shard", () => {
    const runAfter = vi.fn(async () => null);

    beforeEach(() => {
        runAfter.mockClear();
        runAfterOnShard.mockClear();
    });

    it("sends a record whose caller read the thread straight to the user's shard", () => {
        const threadAttribution = { projectKey: "p1" };

        scheduleReplyUsage({ runAfter } as never, { ...ARGS, threadAttribution });

        expect(runAfter).not.toHaveBeenCalled();
        expect(runAfterOnShard).toHaveBeenCalledWith(expect.anything(), 0, internal.usage.activity.recordReplyUsage, { ...ARGS, threadAttribution }, "u1");
    });

    it("forwards a record with only a thread id through this shard, which holds the thread", () => {
        scheduleReplyUsage({ runAfter } as never, ARGS);

        expect(runAfter).toHaveBeenCalledWith(0, internal.usage.activity.forwardReplyUsage, ARGS);
        expect(runAfterOnShard).not.toHaveBeenCalled();
    });
});

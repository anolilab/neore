import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAfterOnShard, runAfterWithRetry, servesUser } = vi.hoisted(() => {
    return { runAfterOnShard: vi.fn(async () => null), runAfterWithRetry: vi.fn(async () => null), servesUser: vi.fn(() => false) };
});

vi.mock("../lib/shard-context", async (importOriginal) => {
    return { ...(await importOriginal<object>()), servesUser };
});
vi.mock("../lib/shard-scheduler", () => {
    return { runAfterOnShard, runAfterWithRetry };
});

const { internal } = await import("../_generated/internal");
const { scheduleReplyUsage } = await import("./schedule");
const { RECORD_FALLBACK_MS, RECORD_RETRY } = await import("./activity-logic");

const ARGS = { at: 1, costMicrodollars: 5, date: "2026-09-20", replyKey: "aside:1", skillKey: "__assistant__", threadId: "t1", tokens: 1, userId: "u1" };

describe("scheduleReplyUsage off the user's shard", () => {
    const runAfter = vi.fn(async () => null);

    beforeEach(() => {
        runAfter.mockClear();
        runAfterOnShard.mockClear();
        runAfterWithRetry.mockClear();
    });

    it("sends a record whose caller read the thread straight to the user's shard", () => {
        const threadAttribution = { projectKey: "p1" };

        scheduleReplyUsage({ runAfter } as never, { ...ARGS, threadAttribution });

        expect(runAfter).not.toHaveBeenCalled();
        expect(runAfterOnShard).toHaveBeenCalledWith(expect.anything(), 0, internal.usage.activity.recordReplyUsage, { ...ARGS, threadAttribution }, "u1");
    });

    it("forwards a record with only a thread id through this shard, which holds the thread, retried if its read fails", () => {
        scheduleReplyUsage({ runAfter } as never, ARGS);

        expect(runAfterWithRetry).toHaveBeenCalledWith(expect.anything(), 0, internal.usage.activity.forwardReplyUsage, ARGS, RECORD_RETRY);
        // Should every try fail, the fallback lands the reply's total without a project, well after the last one.
        expect(runAfterOnShard).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            RECORD_FALLBACK_MS,
            internal.usage.activity.recordReplyUsage,
            { ...ARGS, fallback: true, threadAttribution: {} },
            "u1",
        );
    });
});

describe("scheduleReplyUsage on the user's shard", () => {
    const runAfter = vi.fn(async () => null);

    beforeEach(() => {
        servesUser.mockReturnValue(true);
        runAfter.mockClear();
        runAfterOnShard.mockClear();
        runAfterWithRetry.mockClear();
    });

    it("keeps the scheduler's default retries, and schedules no fallback, for a record with no project to read", () => {
        const brief = { at: 1, costMicrodollars: 5, date: "2026-09-20", replyKey: "brief:1", skillKey: "__daily_brief__", tokens: 1, userId: "u1" };

        scheduleReplyUsage({ runAfter } as never, brief);

        expect(runAfter).toHaveBeenCalledWith(0, internal.usage.activity.recordReplyUsage, brief);
        expect(runAfterWithRetry).not.toHaveBeenCalled();
        expect(runAfterOnShard).not.toHaveBeenCalled();
    });
});

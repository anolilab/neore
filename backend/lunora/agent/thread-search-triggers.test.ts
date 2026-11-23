/**
 * The palette-search triggers, with the builder and the scheduler replaced by fakes.
 * A delete must fail when its vector cleanup cannot be scheduled, since nothing
 * later would queue it; a write's sync may fail without failing the write.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { CLEANUP_RETRY, SYNC_RETRY, threadSearchTriggers } from "./thread-search-triggers";

type Handler = (context: unknown, event: unknown) => Promise<void>;

const triggers = threadSearchTriggers({
    afterDelete: (handler: Handler) => handler,
    afterInsert: (handler: Handler) => handler,
    afterUpdate: (handler: Handler) => handler,
} as never) as unknown as { threadSearchDelete: Handler; threadSearchInsert: Handler; threadSearchUpdate: Handler };

const failingScheduler = () => {
    return { runAfter: vi.fn().mockRejectedValue(new Error("scheduler down")) };
};

describe("threadSearchTriggers", () => {
    it("fails the delete when the vector cleanup cannot be scheduled", async () => {
        const scheduler = failingScheduler();

        await expect(triggers.threadSearchDelete({ scheduler }, { id: "t1", previous: { titleVectorId: "v1" } })).rejects.toThrow("scheduler down");
    });

    it("schedules the cleanup with the deleted thread's vector ids, on the owner's shard, retried until it succeeds", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchDelete({ scheduler }, { id: "t1", previous: { summaryVectorId: "s1", titleVectorId: "v1", userId: "u1" } });

        expect(scheduler.runAfter).toHaveBeenCalledWith(
            0,
            internal.agent.thread_search.deleteThreadVectors,
            { vectorIds: ["v1", "s1"] },
            // `forever`: the scheduler's default policy dead-letters after five retries, and nothing queues this cleanup again.
            { retry: { backoff: "exponential", baseMs: 60_000, forever: true }, shardKey: "u1" },
        );
    });

    it("still schedules the cleanup when the deleted thread has no owner, rather than skipping it", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchDelete({ scheduler }, { id: "t1", previous: { titleVectorId: "v1" } });

        expect(scheduler.runAfter).toHaveBeenCalledWith(0, internal.agent.thread_search.deleteThreadVectors, { vectorIds: ["v1"] }, { retry: CLEANUP_RETRY });
    });

    it("keeps the insert when its sync cannot be scheduled", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(
            triggers.threadSearchInsert({ scheduler: failingScheduler() }, { doc: { title: "Hello", userId: "u1", userTurnCount: 4 }, id: "t1" }),
        ).resolves.toBeUndefined();

        warn.mockRestore();
    });

    it.each([
        ["archive", "active", "archived"],
        ["restore", "archived", "active"],
    ])("schedules the vectors' archived flag on the owner's shard on %s", async (_name, before, after) => {
        const scheduler = { runAfter: vi.fn(async () => "job") };
        const row = { title: "Hello", titleVectorId: "v1", userId: "u1", userTurnCount: 4 };

        await triggers.threadSearchUpdate({ scheduler }, { doc: { ...row, status: after }, id: "t1", previous: { ...row, status: before } });

        expect(scheduler.runAfter).toHaveBeenCalledExactlyOnceWith(
            0,
            internal.agent.thread_vector_archived.syncThreadVectorArchived,
            { threadId: "t1" },
            { retry: SYNC_RETRY, shardKey: "u1" },
        );
    });

    it("schedules no flag update for a thread without vectors, or a write that leaves the archive state", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };
        const row = { title: "Hello", userId: "u1", userTurnCount: 4 };

        await triggers.threadSearchUpdate({ scheduler }, { doc: { ...row, status: "archived" }, id: "t1", previous: { ...row, status: "active" } });
        await triggers.threadSearchUpdate(
            { scheduler },
            { doc: { ...row, status: "active", titleVectorId: "v1" }, id: "t1", previous: { ...row, status: "active", titleVectorId: "v1" } },
        );

        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("schedules an insert's sync with the retry policy, on the owner's shard", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchInsert({ scheduler }, { doc: { title: "Hello", userId: "u1", userTurnCount: 4 }, id: "t1" });

        expect(scheduler.runAfter).toHaveBeenCalledWith(
            0,
            internal.agent.thread_search.syncThreadSearch,
            { changed: ["title"], threadId: "t1" },
            { retry: SYNC_RETRY, shardKey: "u1" },
        );
    });
});

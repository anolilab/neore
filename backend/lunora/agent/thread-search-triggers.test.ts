/**
 * The palette-search triggers, with the builder and the scheduler replaced by fakes.
 * A delete must fail when its vector cleanup cannot be scheduled, since nothing
 * later would queue it; a write's sync may fail without failing the write.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { SYNC_RETRY, threadSearchTriggers } from "./thread-search-triggers";

type Handler = (context: unknown, event: unknown) => Promise<void>;

const triggers = threadSearchTriggers({
    afterDelete: (handler: Handler) => handler,
    afterInsert: (handler: Handler) => handler,
    afterUpdate: (handler: Handler) => handler,
} as never) as unknown as { threadSearchDelete: Handler; threadSearchInsert: Handler };

const failingScheduler = () => {
    return { runAfter: vi.fn().mockRejectedValue(new Error("scheduler down")) };
};

describe("threadSearchTriggers", () => {
    it("fails the delete when the vector cleanup cannot be scheduled", async () => {
        const scheduler = failingScheduler();

        await expect(triggers.threadSearchDelete({ scheduler }, { id: "t1", previous: { titleVectorId: "v1" } })).rejects.toThrow("scheduler down");
    });

    it("schedules the cleanup with the deleted thread's vector ids", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchDelete({ scheduler }, { id: "t1", previous: { summaryVectorId: "s1", titleVectorId: "v1" } });

        expect(scheduler.runAfter).toHaveBeenCalledWith(0, internal.agent.thread_search.deleteThreadVectors, { vectorIds: ["v1", "s1"] });
    });

    it("keeps the insert when its sync cannot be scheduled", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(
            triggers.threadSearchInsert({ scheduler: failingScheduler() }, { doc: { title: "Hello", userId: "u1" }, id: "t1" }),
        ).resolves.toBeUndefined();

        warn.mockRestore();
    });

    it("schedules an insert's sync with the retry policy", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchInsert({ scheduler }, { doc: { title: "Hello", userId: "u1" }, id: "t1" });

        expect(scheduler.runAfter).toHaveBeenCalledWith(
            0,
            internal.agent.thread_search.syncThreadSearch,
            { changed: ["title"], threadId: "t1" },
            { retry: SYNC_RETRY },
        );
    });
});

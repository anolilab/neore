/**
 * The messages triggers for the palette's turn gate. A user turn inserted or deleted, or a row whose
 * role changes to or from `user`, moves the thread's user-turn count. A sync is scheduled only when
 * the count crosses the gate, either way, on the thread owner's shard. Other rows change nothing,
 * and a thread being hard-deleted is left alone.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { SYNC_RETRY, threadSearchMessageTriggers } from "./thread-search-triggers";

type Handler = (context: unknown, event: unknown) => Promise<void>;

const triggers = threadSearchMessageTriggers({
    afterDelete: (handler: Handler) => handler,
    afterInsert: (handler: Handler) => handler,
    afterUpdate: (handler: Handler) => handler,
} as never) as unknown as { threadSearchTurnDelete: Handler; threadSearchTurnInsert: Handler; threadSearchTurnUpdate: Handler };

const syncOf = { changed: [], threadId: "t1" };
const onOwnerShard = { retry: SYNC_RETRY, shardKey: "u1" };

/** A database with one thread row; `patch` is recorded. */
const databaseWith = (thread: { deletingAt?: number; userTurnCount?: number } | null) => {
    const patch = vi.fn(async () => undefined);
    const get = vi.fn(async () => (thread === null ? null : { _id: "t1", userId: "u1", ...thread }));

    return { db: { get, patch }, patch };
};

describe("threadSearchMessageTriggers", () => {
    it("counts an inserted user turn on its thread, and schedules nothing", async () => {
        const { db, patch } = databaseWith({ userTurnCount: 2 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnInsert({ db, scheduler }, { doc: { message: { role: "user" }, threadId: "t1" }, id: "m1" });

        expect(patch).toHaveBeenCalledWith("threads", "t1", { userTurnCount: 3 });
        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("schedules a gate check on the owner's shard when a delete takes the thread below the gate", async () => {
        const { db, patch } = databaseWith({ userTurnCount: 4 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnDelete({ db, scheduler }, { id: "m1", previous: { message: { role: "user" }, threadId: "t1" } });

        expect(patch).toHaveBeenCalledWith("threads", "t1", { userTurnCount: 3 });
        expect(scheduler.runAfter).toHaveBeenCalledWith(0, internal.agent.thread_search.syncThreadSearch, syncOf, onOwnerShard);
    });

    it("schedules the sync when an insert takes the thread over the gate, without waiting for a reply", async () => {
        const { db, patch } = databaseWith({ userTurnCount: 3 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnInsert({ db, scheduler }, { doc: { message: { role: "user" }, threadId: "t1" }, id: "m1" });

        expect(patch).toHaveBeenCalledWith("threads", "t1", { userTurnCount: 4 });
        expect(scheduler.runAfter).toHaveBeenCalledWith(0, internal.agent.thread_search.syncThreadSearch, syncOf, onOwnerShard);
    });

    it("takes a user turn away when an update makes it another role, and clears the vectors below the gate", async () => {
        const { db, patch } = databaseWith({ userTurnCount: 4 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnUpdate(
            { db, scheduler },
            { doc: { message: { role: "assistant" }, threadId: "t1" }, id: "m1", previous: { message: { role: "user" }, threadId: "t1" } },
        );

        expect(patch).toHaveBeenCalledWith("threads", "t1", { userTurnCount: 3 });
        expect(scheduler.runAfter).toHaveBeenCalledWith(0, internal.agent.thread_search.syncThreadSearch, syncOf, onOwnerShard);
    });

    it("adds a user turn when an update makes a row a user turn, and leaves an update that keeps the role alone", async () => {
        const { db, patch } = databaseWith({ userTurnCount: 1 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnUpdate(
            { db, scheduler },
            { doc: { message: { role: "user" }, threadId: "t1" }, id: "m1", previous: { message: { role: "assistant" }, threadId: "t1" } },
        );
        await triggers.threadSearchTurnUpdate(
            { db, scheduler },
            { doc: { message: { role: "user" }, threadId: "t1" }, id: "m2", previous: { message: { role: "user" }, threadId: "t1" } },
        );

        expect(patch).toHaveBeenCalledOnce();
        expect(patch).toHaveBeenCalledWith("threads", "t1", { userTurnCount: 2 });
        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("counts a delete that stays above the gate without scheduling anything", async () => {
        const { db, patch } = databaseWith({ userTurnCount: 6 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnDelete({ db, scheduler }, { id: "m1", previous: { message: { role: "user" }, threadId: "t1" } });

        expect(patch).toHaveBeenCalledWith("threads", "t1", { userTurnCount: 5 });
        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("leaves a thread that is being hard-deleted alone, so a paged purge schedules nothing", async () => {
        const { db, patch } = databaseWith({ deletingAt: 1, userTurnCount: 4 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnDelete({ db, scheduler }, { id: "m1", previous: { message: { role: "user" }, threadId: "t1" } });

        expect(patch).not.toHaveBeenCalled();
        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("counts from zero for a thread that predates the count, and never goes below zero", async () => {
        const { db, patch } = databaseWith({});
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnDelete({ db, scheduler }, { id: "m1", previous: { message: { role: "user" }, threadId: "t1" } });

        expect(patch).toHaveBeenCalledWith("threads", "t1", { userTurnCount: 0 });
        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("changes nothing when an assistant or tool row is inserted or deleted, or the thread is gone", async () => {
        const { db, patch } = databaseWith({ userTurnCount: 2 });
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnInsert({ db, scheduler }, { doc: { message: { role: "assistant" }, threadId: "t1" }, id: "m2" });
        await triggers.threadSearchTurnDelete({ db, scheduler }, { id: "m3", previous: { message: { role: "tool" }, threadId: "t1" } });

        expect(patch).not.toHaveBeenCalled();
        expect(scheduler.runAfter).not.toHaveBeenCalled();

        const gone = databaseWith(null);

        await triggers.threadSearchTurnDelete({ db: gone.db, scheduler }, { id: "m4", previous: { message: { role: "user" }, threadId: "t1" } });

        expect(gone.patch).not.toHaveBeenCalled();
        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });
});

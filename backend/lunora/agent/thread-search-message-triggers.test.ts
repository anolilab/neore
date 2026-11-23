/**
 * The messages trigger for the turn gate: deleting a user turn schedules a check of the
 * thread's gate, and deleting any other row schedules nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { SYNC_RETRY, threadSearchMessageTriggers } from "./thread-search-triggers";

type Handler = (context: unknown, event: unknown) => Promise<void>;

const triggers = threadSearchMessageTriggers({
    afterDelete: (handler: Handler) => handler,
} as never) as unknown as { threadSearchTurnDelete: Handler };

describe("threadSearchMessageTriggers", () => {
    it("schedules a turn-gate check when a user turn is deleted", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnDelete({ scheduler }, { id: "m1", previous: { message: { role: "user" }, threadId: "t1" } });

        expect(scheduler.runAfter).toHaveBeenCalledWith(
            0,
            internal.agent.thread_search.syncThreadSearch,
            { changed: [], threadId: "t1" },
            { retry: SYNC_RETRY },
        );
    });

    it("schedules nothing when an assistant or tool row is deleted", async () => {
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await triggers.threadSearchTurnDelete({ scheduler }, { id: "m2", previous: { message: { role: "assistant" }, threadId: "t1" } });
        await triggers.threadSearchTurnDelete({ scheduler }, { id: "m3", previous: { message: { role: "tool" }, threadId: "t1" } });

        expect(scheduler.runAfter).not.toHaveBeenCalled();
    });
});

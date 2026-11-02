/**
 * A failed pull request link write is scheduled again with backoff, a bounded number of times, and a thread that is
 * gone is refused without a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PR_LINK_RETRY_DELAYS_MS, recordOpenedPullRequestWithRetry } from "./pr-link-retry";

const LINK = { prUrl: "https://github.com/acme/app/pull/7", threadId: "thread-1", userId: "user-1" };

const contextWith = (runMutation: (...args: unknown[]) => Promise<unknown>) => {
    return {
        runMutation: vi.fn(runMutation),
        scheduler: { runAfter: vi.fn(async (_delay: number, _target: unknown, _args: unknown, _options: unknown) => "job-1") },
    };
};

describe("recordOpenedPullRequestWithRetry", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("records the link and schedules nothing when the write works", async () => {
        const ctx = contextWith(async () => {
            return { created: true, threadId: "thread-1" };
        });

        await recordOpenedPullRequestWithRetry(ctx as never, LINK);

        expect(ctx.runMutation).toHaveBeenCalledOnce();
        expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("schedules the first retry on the owner's shard when the write throws", async () => {
        const ctx = contextWith(async () => {
            throw new Error("D1 is unavailable");
        });

        await expect(recordOpenedPullRequestWithRetry(ctx as never, LINK)).resolves.toBeUndefined();

        expect(ctx.scheduler.runAfter).toHaveBeenCalledOnce();

        const [delay, , args, options] = ctx.scheduler.runAfter.mock.calls[0] ?? [];

        expect(delay).toBe(PR_LINK_RETRY_DELAYS_MS[0]);
        expect(args).toEqual({ ...LINK, attempt: 1 });
        expect(options).toEqual({ shardKey: "user-1" });
    });

    it("records the link on the second attempt and schedules no more", async () => {
        const write = vi
            .fn<(...args: unknown[]) => Promise<unknown>>()
            .mockRejectedValueOnce(new Error("blip"))
            .mockResolvedValueOnce({ created: true, threadId: "thread-1" });
        const ctx = contextWith(write);

        await recordOpenedPullRequestWithRetry(ctx as never, LINK);
        await recordOpenedPullRequestWithRetry(ctx as never, LINK, 1);

        expect(write).toHaveBeenCalledTimes(2);
        expect(ctx.scheduler.runAfter).toHaveBeenCalledOnce();
    });

    it("backs off through every delay, then gives up", async () => {
        const ctx = contextWith(async () => {
            throw new Error("still down");
        });

        for (let attempt = 0; attempt <= PR_LINK_RETRY_DELAYS_MS.length; attempt += 1) {
            await recordOpenedPullRequestWithRetry(ctx as never, LINK, attempt);
        }

        expect(ctx.scheduler.runAfter.mock.calls.map((call) => call[0])).toEqual([...PR_LINK_RETRY_DELAYS_MS]);
        expect(ctx.runMutation).toHaveBeenCalledTimes(PR_LINK_RETRY_DELAYS_MS.length + 1);
    });

    it("does not retry a deleted thread", async () => {
        const ctx = contextWith(async () => {
            throw Object.assign(new Error("That thread is not there"), { code: "NOT_FOUND" });
        });

        await recordOpenedPullRequestWithRetry(ctx as never, LINK);

        expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    });

    it("still returns when the retry cannot be scheduled", async () => {
        const ctx = contextWith(async () => {
            throw new Error("down");
        });

        ctx.scheduler.runAfter.mockRejectedValueOnce(new Error("scheduler down"));

        await expect(recordOpenedPullRequestWithRetry(ctx as never, LINK)).resolves.toBeUndefined();
    });
});

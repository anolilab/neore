import { describe, expect, it, vi } from "vitest";

import { pauseOnRateLimit } from "./pause-run";

const run = { messageId: "m1", streamId: "s1", streamingConfig: { contentType: "text", model: "m" }, threadId: "t1", userId: "u1" };
const limited = Object.assign(new Error("rate limited"), { rateLimit: { status: 429 } });

describe("pauseOnRateLimit", () => {
    it("reads where the run stands only after the model call has settled", async () => {
        const saved: string[] = ["row-1"];
        const runMutation = vi.fn(async () => {
            return { paused: true, retryAt: 1 };
        });

        await pauseOnRateLimit({ runMutation } as never, {
            error: limited,
            progress: () => {
                return { from: saved.at(-1)!, replyRowIds: [...saved], stepsUsed: saved.length };
            },
            reply: {},
            run,
            // The step that was still being saved when the call was rejected lands while it winds down.
            settle: async () => {
                saved.push("row-2");
            },
            streamId: "s1",
        });

        expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ from: "row-2", replyRowIds: ["row-1", "row-2"], stepsUsed: 2 }));
    });

    it("reads the person's usage-limit settings for a rate limit, and passes them to the pause", async () => {
        const usageLimit = vi.fn(async () => {
            return { resumeAfterLimit: false, snoozeUntilReset: true };
        });
        const runMutation = vi.fn(async () => {
            return { paused: true, retryAt: 1 };
        });

        await pauseOnRateLimit({ runMutation } as never, {
            error: limited,
            progress: () => {
                return { from: "row-1", replyRowIds: ["row-1"], stepsUsed: 1 };
            },
            reply: {},
            run,
            settle: async () => undefined,
            streamId: "s1",
            usageLimit,
        });

        expect(usageLimit).toHaveBeenCalledTimes(1);
        expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeAfterLimit: false, snoozeUntilReset: true }));
    });

    it("passes today's behaviour when the settings are not read", async () => {
        const runMutation = vi.fn(async () => {
            return { paused: true, retryAt: 1 };
        });

        await pauseOnRateLimit({ runMutation } as never, {
            error: limited,
            progress: () => {
                return { from: "row-1", replyRowIds: ["row-1"], stepsUsed: 1 };
            },
            reply: {},
            run,
            settle: async () => undefined,
            streamId: "s1",
        });

        expect(runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeAfterLimit: true, snoozeUntilReset: false }));
    });

    it("does not read the settings for an error that is not a rate limit", async () => {
        const usageLimit = vi.fn(async () => {
            return { resumeAfterLimit: false, snoozeUntilReset: true };
        });

        await pauseOnRateLimit({ runMutation: vi.fn() } as never, {
            error: new Error("boom"),
            progress: () => {
                return { from: "row-1", replyRowIds: [], stepsUsed: 0 };
            },
            reply: {},
            run,
            settle: async () => undefined,
            streamId: "s1",
            usageLimit,
        });

        expect(usageLimit).not.toHaveBeenCalled();
    });

    it("asks for nothing when the error is not a rate limit", async () => {
        const runMutation = vi.fn();
        const progress = vi.fn();

        const paused = await pauseOnRateLimit({ runMutation } as never, {
            error: new Error("boom"),
            progress,
            reply: {},
            run,
            settle: async () => undefined,
            streamId: "s1",
        });

        expect(paused).toBe(false);
        expect(runMutation).not.toHaveBeenCalled();
        expect(progress).not.toHaveBeenCalled();
    });
});

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

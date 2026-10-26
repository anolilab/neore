/**
 * `afterRun` awaits the reply's timing patch before it returns, so an action
 * does not end with the mutation in flight, and a failed patch never throws
 * into the run.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { afterRun } from "./agent-run";

const reply = { _id: "msg-1", message: { content: "Hello", role: "assistant" } };

const baseArgs = {
    extractMemory: false,
    firstTokenTime: 1050,
    prompt: "",
    savedMessages: [reply] as never,
    threadId: "thread-1",
    timingStart: 1000,
    userId: "user-a",
};

describe(afterRun, () => {
    it("settles the timing patch after the other work is scheduled and before it returns", async () => {
        expect.assertions(4);

        const order: string[] = [];
        let finishPatch: () => void = () => undefined;
        const ctx = {
            runMutation: vi.fn(async (ref: unknown) => {
                if (ref === internal.agent.messages.patchMessageTiming) {
                    order.push("patch:start");
                    await new Promise<void>((resolve) => {
                        finishPatch = resolve;
                    });
                    order.push("patch:done");
                }
            }),
            scheduler: {
                runAfter: vi.fn(async () => {
                    order.push("schedule");

                    return "job";
                }),
            },
        };

        const done = afterRun(ctx as never, baseArgs).then(() => order.push("returned"));

        // Still pending: the patch has not finished.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(order).not.toContain("returned");

        finishPatch();
        await done;

        expect(order.indexOf("patch:start")).toBeLessThan(order.indexOf("schedule"));
        expect(order.indexOf("patch:done")).toBeLessThan(order.indexOf("returned"));
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.agent.messages.patchMessageTiming, { durationMs: expect.any(Number), messageId: "msg-1", ttftMs: 50 });
    });

    it("does not throw when the timing patch fails", async () => {
        expect.assertions(1);

        const ctx = {
            runMutation: vi.fn(async () => {
                throw new Error("shard busy");
            }),
            scheduler: { runAfter: vi.fn(async () => "job") },
        };

        await expect(afterRun(ctx as never, baseArgs)).resolves.toBeUndefined();
    });

    it("does not throw when a runMutation throws before returning a promise", async () => {
        expect.assertions(1);

        const ctx = {
            runMutation: vi.fn(() => {
                throw new Error("sync failure");
            }),
            scheduler: { runAfter: vi.fn(async () => "job") },
        };

        await expect(afterRun(ctx as never, baseArgs)).resolves.toBeUndefined();
    });
});

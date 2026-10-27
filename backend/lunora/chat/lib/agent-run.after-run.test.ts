/**
 * `afterRun` awaits the reply's timing patch before it returns, so an action
 * does not end with the mutation in flight, and a failed patch never throws
 * into the run.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { streamLogger } from "../../lib/logger";
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
        const patchGates: (() => void)[] = [];
        const ctx = {
            runMutation: vi.fn(async (ref: unknown) => {
                if (ref !== internal.agent.messages.patchMessageTiming) {
                    return;
                }

                order.push("patch:start");
                await new Promise<void>((resolve) => {
                    patchGates.push(resolve);
                });
                order.push("patch:done");
            }),
            scheduler: {
                runAfter: vi.fn(async () => {
                    order.push("schedule");

                    return "job";
                }),
            },
        };

        const done = (async () => {
            await afterRun(ctx as never, baseArgs);
            order.push("returned");
        })();

        // Still pending: the patch has not finished.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(order).not.toContain("returned");

        for (const open of patchGates) {
            open();
        }

        await done;

        expect(order.indexOf("patch:start")).toBeLessThan(order.indexOf("schedule"));
        expect(order.indexOf("patch:done")).toBeLessThan(order.indexOf("returned"));
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.agent.messages.patchMessageTiming, {
            durationMs: expect.any(Number),
            messageId: "msg-1",
            ttftMs: 50,
        });
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

    it("logs a rejected runAfter and still resolves", async () => {
        expect.assertions(3);

        const warn = vi.spyOn(streamLogger, "warn").mockImplementation(() => undefined);
        const failure = new Error("scheduler down");
        const ctx = {
            runMutation: vi.fn(async () => undefined),
            scheduler: {
                runAfter: vi.fn(async () => {
                    throw failure;
                }),
            },
        };

        await expect(afterRun(ctx as never, { ...baseArgs, extractMemory: true, prompt: "Hi" })).resolves.toBeUndefined();

        expect(ctx.scheduler.runAfter).toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("[afterRun] Scheduling the post-run work failed:", failure);

        warn.mockRestore();
    });

    it("resolves only after the scheduling has settled", async () => {
        expect.assertions(2);

        const finishers: (() => void)[] = [];
        const ctx = {
            runMutation: vi.fn(async () => undefined),
            scheduler: {
                runAfter: vi.fn(
                    async () =>
                        await new Promise<string>((resolve) => {
                            finishers.push(() => resolve("job"));
                        }),
                ),
            },
        };
        let returned = false;
        const done = (async () => {
            await afterRun(ctx as never, { ...baseArgs, extractMemory: true, prompt: "Hi" });
            returned = true;
        })();

        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(returned).toBe(false);

        for (const finish of finishers) {
            finish();
        }

        await done;

        expect(returned).toBe(true);
    });
});

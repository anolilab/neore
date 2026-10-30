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

describe("the idle-thread summary job", () => {
    const summaryJobs = (runAfter: ReturnType<typeof vi.fn>) =>
        runAfter.mock.calls.filter((call: unknown[]) => call[1] === internal.agent.thread_summaries.runThreadSummary);

    const run = async (rows: { _id: string; order: number; stepOrder: number }[]) => {
        const runAfter = vi.fn(async () => "job");

        await afterRun({ runMutation: vi.fn(async () => undefined), scheduler: { runAfter } } as never, {
            ...baseArgs,
            savedMessages: rows.map((row) => {
                return { ...row, message: { content: "x", role: "assistant" } };
            }) as never,
        });

        return runAfter;
    };

    it("is scheduled a few minutes after a reply in a long-running thread, naming the reply's last row", async () => {
        expect.assertions(3);

        const runAfter = await run([
            { _id: "user-row", order: 40, stepOrder: 0 },
            { _id: "tool-row", order: 40, stepOrder: 1 },
            { _id: "last-row", order: 40, stepOrder: 2 },
        ]);
        const [job] = summaryJobs(runAfter);

        expect(summaryJobs(runAfter)).toHaveLength(1);
        expect(job?.[0]).toBe(5 * 60 * 1000);
        expect(job?.[2]).toStrictEqual({ afterMessageId: "last-row", threadId: "thread-1" });
    });

    it("is not scheduled for a thread of only a few turns", async () => {
        expect.assertions(1);

        expect(summaryJobs(await run([{ _id: "last-row", order: 3, stepOrder: 1 }]))).toHaveLength(0);
    });

    it("moves with each reply: a second reply schedules its own job for its own last row", async () => {
        expect.assertions(2);

        const first = summaryJobs(await run([{ _id: "reply-1", order: 40, stepOrder: 1 }]));
        const second = summaryJobs(await run([{ _id: "reply-2", order: 41, stepOrder: 1 }]));

        expect(first[0]?.[2].afterMessageId).toBe("reply-1");
        expect(second[0]?.[2].afterMessageId).toBe("reply-2");
    });
});

/**
 * An abort fails the generation's pending reply row from a listener. The run that
 * started the generation must not return until that write has landed, also when the
 * generation retried after a context-exceeded error and the abort reaches an attempt
 * the retry left behind.
 */
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import streamText from "./stream-text";

const ROWS = [
    {
        _creationTime: 1,
        _id: "m1",
        message: { content: "the prompt", role: "user" },
        order: 1,
        status: "success",
        stepOrder: 0,
        text: "the prompt",
        threadId: "thread-1",
        tool: false,
    },
];

/** A model call that never answers. */
const never = async (): Promise<never> =>
    await new Promise<never>(() => {
        // intentionally never settles
    });

const sleep = async (ms: number) => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

/** Lets the abort listeners and anything they started run to their next await. */
const flush = async () => {
    for (let index = 0; index < 20; index += 1) {
        await sleep(0);
    }
};

/** A thread whose pending rows are numbered p1, p2…; after `hold()`, finalizing the rows named in `held` waits for `release`. */
const fakeThread = (held: string[], beforeFirstStreamFails?: () => Promise<void>, rejectAddMessagesFrom?: number) => {
    let release = () => {};
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const finalized: string[] = [];
    const started: string[] = [];
    let pending = 0;
    let holding = false;
    let creates = 0;
    let adds = 0;
    // Only the first finalize of a held row waits: a later one for the same row goes through.
    const heldOnce = new Set<string>();
    const runMutation = vi.fn(async (ref: unknown, args: { messageId: string }) => {
        if (ref === internal.agent.messages.addMessages) {
            adds += 1;

            if (rejectAddMessagesFrom && adds >= rejectAddMessagesFrom) {
                throw new Error("the pending row could not be created");
            }

            pending += 1;

            return { messages: [{ _id: `p${pending}`, order: 1, status: "pending", stepOrder: pending }] };
        }

        if (ref === internal.agent.messages.finalizeMessage) {
            started.push(args.messageId);

            if (holding && held.includes(args.messageId) && !heldOnce.has(args.messageId)) {
                heldOnce.add(args.messageId);
                await gate;
            }

            finalized.push(args.messageId);

            return null;
        }

        if (ref === internal.agent.streams.create) {
            creates += 1;

            if (beforeFirstStreamFails && creates === 1) {
                // Held until the model's error has been read as a context overflow, so the failed stream takes the retry path.
                await beforeFirstStreamFails();

                throw new Error("the stream could not be created");
            }

            return `stream-${creates}`;
        }

        if (ref === internal.agent.streams.addDelta) {
            return true;
        }

        return null;
    });
    const runQuery = vi.fn(async (ref: unknown) => {
        if (ref === internal.agent.context_reset_read.getContextReset) {
            return null;
        }

        if (ref === internal.agent.thread_summaries.getThreadSummaryForContext) {
            return null;
        }

        if (ref === internal.agent.agent_switch.getHandoffAbove) {
            return [];
        }

        return ref === internal.agent.branches.getContextPathIds ? null : { page: ROWS };
    });

    return {
        context: { runMutation, runQuery, storage: {} } as never,
        finalized,
        hold: () => {
            holding = true;
        },
        release: () => {
            release();
        },
        started,
    };
};

const OPTIONS = { agentName: "agent", threadId: "thread-1", userId: "user-1" };

describe("settleAbort of a streamed generation", () => {
    it("does not settle until the pending row's failure has landed", async () => {
        expect.assertions(4);

        const thread = fakeThread(["p1"]);
        const model = new MockLanguageModelV3({ doStream: async () => await never() });
        const controller = new AbortController();
        const result = await streamText(
            thread.context,
            {} as never,
            { abortSignal: controller.signal, model, promptMessageId: "m1" } as never,
            OPTIONS as never,
        );

        thread.hold();
        controller.abort("stopped");

        let settled = false;
        const settling = (async () => {
            await result.settleAbort();
            settled = true;
        })();

        await flush();

        expect(thread.started).toStrictEqual(["p1"]);
        expect(settled).toBe(false);

        thread.release();
        await settling;

        expect(settled).toBe(true);
        expect(thread.finalized).toStrictEqual(["p1"]);
    });

    it("also waits for the abort work of an attempt the context-exceeded retry left behind", async () => {
        expect.assertions(5);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const overflowSeen = async () => {
            while (warn.mock.calls.every(([message]) => !String(message).includes("Context exceeded detected"))) {
                await sleep(0);
            }
        };
        const thread = fakeThread(["p1"], overflowSeen);
        const controller = new AbortController();
        let calls = 0;
        const model = new MockLanguageModelV3({
            doStream: async () => {
                calls += 1;

                if (calls === 1) {
                    throw new Error("prompt is too long: the context length was exceeded");
                }

                return await never();
            },
        });
        const running = streamText(
            thread.context,
            {} as never,
            { abortSignal: controller.signal, model, promptMessageId: "m1" } as never,
            { ...OPTIONS, saveStreamDeltas: true } as never,
        );

        // The retry is generating when the shared signal fires; the first attempt's row is p1, the retry's p2.
        while (calls < 2) {
            await flush();
        }

        thread.hold();

        const startedBefore = thread.started.length;
        const finalizedBefore = thread.finalized.length;

        controller.abort("stopped");

        const result = await running;
        let settled = false;
        const settling = (async () => {
            await result.settleAbort();
            settled = true;
        })();

        await flush();

        // The abort reached the first attempt's row too, and that write is still open.
        expect(thread.started.slice(startedBefore)).toContain("p1");
        expect(thread.finalized.slice(finalizedBefore)).not.toContain("p1");
        expect(settled).toBe(false);

        thread.release();
        await settling;

        expect(settled).toBe(true);
        expect(thread.finalized.slice(finalizedBefore)).toContain("p1");

        warn.mockRestore();
    });

    it("does not reject while the first attempt's abort write is open when the retry fails to start", async () => {
        expect.assertions(6);

        const controller = new AbortController();
        let overflowRead = false;
        const thread = fakeThread(
            ["p1"],
            async () => {
                while (!overflowRead) {
                    await sleep(0);
                }
            },
            2,
        );
        // The abort lands right as the first attempt's overflow is read, before it has started its retry.
        const warn = vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
            if (!String(message).includes("Context exceeded detected")) {
                return;
            }

            overflowRead = true;
            thread.hold();
            controller.abort("stopped");
        });
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const model = new MockLanguageModelV3({
            doStream: async () => {
                throw new Error("prompt is too long: the context length was exceeded");
            },
        });
        let outcome: unknown;
        let settledAs: "rejected" | "resolved" | undefined;
        const running = streamText(
            thread.context,
            {} as never,
            { abortSignal: controller.signal, model, promptMessageId: "m1" } as never,
            { ...OPTIONS, saveStreamDeltas: true } as never,
        )
            .then((value) => {
                settledAs = "resolved";
                outcome = value;

                return value;
            })
            .catch((error_: unknown) => {
                settledAs = "rejected";
                outcome = error_;
            });

        await flush();

        // The retry's own failure of the row landed; the abort's write for the same row is still open, and the run has not ended around it.
        expect(thread.started.filter((id) => id === "p1")).toHaveLength(2);
        expect(thread.finalized.filter((id) => id === "p1")).toHaveLength(1);
        expect(settledAs).toBeUndefined();

        thread.release();
        await running;

        expect(thread.finalized.filter((id) => id === "p1")).toHaveLength(2);
        expect(settledAs).toBe("rejected");
        expect(outcome).toStrictEqual(new Error("the pending row could not be created"));

        warn.mockRestore();
        error.mockRestore();
    });
});

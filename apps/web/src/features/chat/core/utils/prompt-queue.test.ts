import { describe, expect, it, vi } from "vitest";

import type { PromptQueueState } from "./prompt-queue";
import {
    decideAutoSend,
    deliveredSteerItems,
    dequeuePrompt,
    EMPTY_PROMPT_QUEUE,
    enqueuePrompt,
    removeQueuedPrompt,
    restorePromptQueue,
    serializePromptQueue,
    settleQueuedSteer,
    takeNextToSend,
} from "./prompt-queue";

const item = (id: string) => {
    return { attachments: [], id, text: `text ${id}` };
};

describe("prompt queue transitions", () => {
    it("keeps submission order and drains from the front", () => {
        let state: PromptQueueState<never> = EMPTY_PROMPT_QUEUE;

        state = enqueuePrompt(state, item("a"));
        state = enqueuePrompt(state, item("b"));

        const first = dequeuePrompt(state);

        expect(first.next?.id).toBe("a");
        expect(first.state.items.map((i) => i.id)).toStrictEqual(["b"]);
        expect(dequeuePrompt(first.state).next?.id).toBe("b");
        expect(dequeuePrompt(EMPTY_PROMPT_QUEUE).next).toBeUndefined();
    });

    it("removes an item by id and unpauses once empty", () => {
        const state: PromptQueueState<never> = { items: [item("a"), item("b")], paused: true };

        expect(removeQueuedPrompt(state, "a")).toStrictEqual({ items: [item("b")], paused: true });
        expect(removeQueuedPrompt({ items: [item("a")], paused: true }, "a")).toStrictEqual({ items: [], paused: false });
    });

    it("does not mutate the input state", () => {
        const state: PromptQueueState<never> = { items: [item("a")], paused: false };

        enqueuePrompt(state, item("b"));
        dequeuePrompt(state);
        removeQueuedPrompt(state, "a");

        expect(state.items).toHaveLength(1);
    });
});

describe(decideAutoSend, () => {
    const base = { hasError: false, isStreaming: false, paused: false, queueLength: 1, wasStreaming: true };

    it("sends when a stream finishes with items queued", () => {
        expect(decideAutoSend(base)).toBe("send");
    });

    it("only acts on a streaming -> idle transition", () => {
        expect(decideAutoSend({ ...base, wasStreaming: false })).toBe("idle");
        expect(decideAutoSend({ ...base, isStreaming: true })).toBe("idle");
    });

    it("stays idle when paused (manual stop) or empty", () => {
        expect(decideAutoSend({ ...base, paused: true })).toBe("idle");
        expect(decideAutoSend({ ...base, queueLength: 0 })).toBe("idle");
    });

    it("pauses instead of sending when the stream ended in an error", () => {
        expect(decideAutoSend({ ...base, hasError: true })).toBe("pause");
    });
});

describe("prompt queue persistence", () => {
    it("round-trips text, drops attachments with a count, and restores paused", () => {
        const state: PromptQueueState<string> = {
            items: [
                { attachments: ["file-1", "file-2"], id: "a", text: "with files" },
                { attachments: [], id: "b", text: "plain" },
            ],
            paused: false,
        };

        expect(restorePromptQueue(serializePromptQueue(state))).toStrictEqual({
            items: [
                { attachments: [], droppedAttachments: 2, id: "a", text: "with files" },
                { attachments: [], id: "b", text: "plain" },
            ],
            paused: true,
        });
    });

    it("keeps a steered prompt's stream and id across a reload, so it is withdrawn before it is sent", () => {
        const steer = { id: "steer-1", streamId: "stream-1" };

        expect(restorePromptQueue(serializePromptQueue({ items: [{ attachments: [], id: "a", steer, text: "go left" }], paused: false }))).toStrictEqual({
            items: [{ attachments: [], id: "a", steer, text: "go left" }],
            paused: true,
        });
        expect(restorePromptQueue(JSON.stringify({ items: [{ id: "a", steer: { id: 1 }, text: "go left" }] }))?.items[0]).toStrictEqual({
            attachments: [],
            id: "a",
            text: "go left",
        });
    });

    it("leaves out attachment-only prompts and stores nothing for an empty queue", () => {
        expect(serializePromptQueue({ items: [{ attachments: ["file"], id: "a", text: "  " }], paused: false })).toBeUndefined();
        expect(serializePromptQueue(EMPTY_PROMPT_QUEUE)).toBeUndefined();
    });

    it("reads malformed storage as no queue", () => {
        expect(restorePromptQueue(null)).toBeUndefined();
        expect(restorePromptQueue("{not json")).toBeUndefined();
        expect(restorePromptQueue(JSON.stringify({ items: "nope" }))).toBeUndefined();
        expect(restorePromptQueue(JSON.stringify({ items: [{ id: 1, text: "x" }, null] }))).toBeUndefined();
    });
});

describe("deliveredSteerItems", () => {
    it("names the steered prompts this stream has taken, and nothing else", () => {
        const items = [
            { attachments: [], id: "plain", text: "later" },
            { attachments: [], id: "taken", steer: { id: "s1", streamId: "stream-1" }, text: "go left" },
            { attachments: [], id: "waiting", steer: { id: "s2", streamId: "stream-1" }, text: "go right" },
            { attachments: [], id: "older", steer: { id: "s1", streamId: "stream-0" }, text: "stop" },
        ];

        expect(deliveredSteerItems(items, "stream-1", ["s1"])).toStrictEqual(["taken"]);
    });
});

describe("takeNextToSend", () => {
    const steer = { id: "s1", streamId: "stream-1" };

    /** A queue the helper reads and edits, like the store does. */
    const queueOf = <T extends { id: string }>(items: T[]) => {
        return {
            items,
            peek: () => items[0],
            remove: (id: string) => {
                const index = items.findIndex((entry) => entry.id === id);

                if (index !== -1) {
                    items.splice(index, 1);
                }
            },
        };
    };

    it("sends a plain prompt without withdrawing anything", async () => {
        const withdraw = vi.fn();
        const queue = queueOf([{ attachments: [], id: "a", text: "hi" }]);

        expect(await takeNextToSend({ ...queue, withdraw })).toStrictEqual({ kind: "send", prompt: { attachments: [], id: "a", text: "hi" } });
        expect(withdraw).not.toHaveBeenCalled();
        expect(queue.items).toHaveLength(0);
    });

    it("sends a steer the reply never took, or whose stream is gone", async () => {
        for (const outcome of ["withdrawn", "unknown"] as const) {
            const prompt = { attachments: [], id: "a", steer, text: "go left" };
            const queue = queueOf([prompt]);

            expect(await takeNextToSend({ ...queue, withdraw: async () => outcome })).toStrictEqual({ kind: "send", prompt });
            expect(queue.items).toHaveLength(0);
        }
    });

    it("drops a steer the reply already took, and sends the prompt after it", async () => {
        const queue = queueOf([
            { attachments: [], id: "a", steer, text: "go left" },
            { attachments: [], id: "b", text: "then this" },
        ]);

        expect(await takeNextToSend({ ...queue, withdraw: async () => "delivered" })).toStrictEqual({
            kind: "send",
            prompt: { attachments: [], id: "b", text: "then this" },
        });
        expect(queue.items).toHaveLength(0);
    });

    it("keeps a steer at the head when its withdrawal fails, so nothing is lost, reordered or sent twice", async () => {
        const prompt = { attachments: [], id: "a", steer, text: "go left" };
        const queue = queueOf([prompt, { attachments: [], id: "b", text: "then this" }]);

        expect(
            await takeNextToSend({
                ...queue,
                withdraw: async () => {
                    throw new Error("offline");
                },
            }),
        ).toStrictEqual({ kind: "failed" });
        expect(queue.items.map((entry) => entry.id)).toStrictEqual(["a", "b"]);
    });

    it("does not send a steer that left the queue while its withdrawal was out", async () => {
        const queue = queueOf([
            { attachments: [], id: "a", steer, text: "go left" },
            { attachments: [], id: "b", text: "then this" },
        ]);

        expect(
            await takeNextToSend({
                ...queue,
                withdraw: async () => {
                    queue.remove("a");

                    return "withdrawn";
                },
            }),
        ).toStrictEqual({ kind: "send", prompt: { attachments: [], id: "b", text: "then this" } });
    });

    it("leaves the head in place when a reply started while the withdrawal was out", async () => {
        const prompt = { attachments: [], id: "a", steer, text: "go left" };
        const queue = queueOf([prompt, { attachments: [], id: "b", text: "then this" }]);
        let streaming = false;

        expect(
            await takeNextToSend({
                ...queue,
                canSend: () => !streaming,
                withdraw: async () => {
                    streaming = true;

                    return "withdrawn";
                },
            }),
        ).toStrictEqual({ kind: "blocked" });
        expect(queue.items.map((entry) => entry.id)).toStrictEqual(["a", "b"]);
    });

    it("leaves a plain head in place while sending is not allowed", async () => {
        const queue = queueOf([{ attachments: [], id: "a", text: "hi" }]);

        expect(await takeNextToSend({ ...queue, canSend: () => false, withdraw: vi.fn() })).toStrictEqual({ kind: "blocked" });
        expect(queue.items).toHaveLength(1);
    });

    it("still drops a steer the reply took while sending is blocked", async () => {
        const queue = queueOf([{ attachments: [], id: "a", steer, text: "go left" }]);

        expect(await takeNextToSend({ ...queue, canSend: () => false, withdraw: async () => "delivered" })).toBeUndefined();
        expect(queue.items).toHaveLength(0);
    });

    it("returns nothing for a queue that only held delivered steers", async () => {
        const queue = queueOf([{ attachments: [], id: "a", steer, text: "go left" }]);

        expect(await takeNextToSend({ ...queue, withdraw: async () => "delivered" })).toBeUndefined();
    });

    it("holds at a steer whose call is still out, without withdrawing or sending behind it", async () => {
        const withdraw = vi.fn();
        const queue = queueOf([
            { attachments: [], id: "a", steer: { ...steer, pending: true }, text: "go left" },
            { attachments: [], id: "b", text: "later" },
        ]);

        expect(await takeNextToSend({ ...queue, withdraw })).toStrictEqual({ kind: "blocked" });
        expect(withdraw).not.toHaveBeenCalled();
        expect(queue.items).toHaveLength(2);
    });
});

describe(settleQueuedSteer, () => {
    const pendingQueue = (): PromptQueueState<never> => {
        return {
            items: [
                { attachments: [], id: "a", steer: { id: "s1", pending: true, streamId: "stream-1" }, text: "go left" },
                { attachments: [], id: "b", text: "later" },
            ],
            paused: false,
        };
    };

    it("keeps an answered steer in its place, no longer pending", () => {
        const settled = settleQueuedSteer(pendingQueue(), "s1", "accepted");

        expect(settled.items.map((entry) => entry.id)).toStrictEqual(["a", "b"]);
        expect(settled.items[0]?.steer).toStrictEqual({ id: "s1", streamId: "stream-1" });
    });

    it("turns a refused steer into a plain queued message in the same place", () => {
        const settled = settleQueuedSteer(pendingQueue(), "s1", "refused");

        expect(settled.items.map((entry) => entry.id)).toStrictEqual(["a", "b"]);
        expect(settled.items[0]).toStrictEqual({ attachments: [], id: "a", text: "go left" });
    });

    it("leaves the queue alone when the steer is gone", () => {
        const queue = pendingQueue();

        expect(settleQueuedSteer(queue, "other", "refused")).toBe(queue);
    });

    it("stores a pending steer as a plain one, so a reload reconciles it by id", () => {
        const restored = restorePromptQueue(serializePromptQueue(pendingQueue()));

        expect(restored?.items[0]?.steer).toStrictEqual({ id: "s1", streamId: "stream-1" });
    });
});

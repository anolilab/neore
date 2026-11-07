import { describe, expect, it, vi } from "vitest";

import type { PromptQueueState } from "./prompt-queue";
import {
    decideAutoSend,
    deliveredSteerItems,
    dequeuePrompt,
    editQueuedPrompt,
    EMPTY_PROMPT_QUEUE,
    enqueuePrompt,
    moveQueuedPrompt,
    prependPrompt,
    removeQueuedPrompt,
    restorePromptQueue,
    serializePromptQueue,
    settleQueuedSteer,
    stepQueuedPrompt,
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

    it("puts a prepended item first and leaves the rest in order", () => {
        const state = prependPrompt({ items: [item("a"), item("b")], paused: true }, item("c"));

        expect(state.items.map((i) => i.id)).toStrictEqual(["c", "a", "b"]);
        expect(state.paused).toBe(true);
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

    it("keeps whether a send may have been taken across a reload, and an edit, a new message, drops it", () => {
        const tried: PromptQueueState<never> = { items: [{ attachments: [], id: "a", text: "go", tried: true }], paused: false };

        expect(restorePromptQueue(serializePromptQueue(tried))?.items[0]?.tried).toBe(true);
        expect(editQueuedPrompt(tried, "a", "go further", "b").items[0]).toStrictEqual({ attachments: [], id: "b", text: "go further" });
    });

    it("leaves out a prompt with no text and no kept attachment, and stores nothing for an empty queue", () => {
        expect(serializePromptQueue({ items: [{ attachments: ["file"], id: "a", text: "  " }], paused: false })).toBeUndefined();
        expect(serializePromptQueue(EMPTY_PROMPT_QUEUE)).toBeUndefined();
    });

    it("drops a restored item whose text is empty once its hidden characters are stripped", () => {
        const stored = JSON.stringify({
            items: [
                { id: "a", text: "\u{E0041}\u{202E}" },
                { id: "b", text: "keep\u{202E}" },
            ],
        });

        expect(restorePromptQueue(stored)?.items.map((entry) => [entry.id, entry.text])).toStrictEqual([["b", "keep"]]);
        expect(restorePromptQueue(JSON.stringify({ items: [{ id: "a", text: "\u{200B}" }] }))).toBeUndefined();
    });

    it("reads malformed storage as no queue", () => {
        expect(restorePromptQueue(null)).toBeUndefined();
        expect(restorePromptQueue("{not json")).toBeUndefined();
        expect(restorePromptQueue(JSON.stringify({ items: "nope" }))).toBeUndefined();
        expect(restorePromptQueue(JSON.stringify({ items: [{ id: 1, text: "x" }, null] }))).toBeUndefined();
        // One beside text is counted as removed, so the chip says so.
        const beside = restorePromptQueue(JSON.stringify({ items: [{ attachments: [{ fileId: "", kind: "image", name: "a" }], id: "a", text: "x" }] }), String);

        expect(beside?.items[0]?.droppedAttachments).toBe(1);
        // A stored attachment without a file id is no attachment, so a prompt made only of one restores as nothing.
        expect(
            restorePromptQueue(JSON.stringify({ items: [{ attachments: [{ fileId: "", kind: "image", name: "a" }], id: "a", text: "" }] }), String),
        ).toBeUndefined();
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
            plain: (head: { id: string }) => {
                items.splice(
                    0,
                    items.length,
                    ...items.map((entry) =>
                        entry.id === head.id ? (Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "steer")) as T) : entry,
                    ),
                );
            },
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

    it("turns a withdrawn steer into a plain prompt when a reply started while the withdrawal was out", async () => {
        const queue = queueOf([
            { attachments: [], id: "a", steer, text: "go left" },
            { attachments: [], id: "b", text: "then this" },
        ]);
        const withdraw = vi.fn(async () => "withdrawn" as const);

        expect(await takeNextToSend({ ...queue, canSend: () => false, withdraw })).toStrictEqual({ kind: "blocked" });
        expect(queue.items).toStrictEqual([
            { attachments: [], id: "a", text: "go left" },
            { attachments: [], id: "b", text: "then this" },
        ]);
        // The head is plain now, so a later pass does not ask the server about it again.
        expect(await takeNextToSend({ ...queue, canSend: () => false, withdraw })).toStrictEqual({ kind: "blocked" });
        expect(withdraw).toHaveBeenCalledTimes(1);
    });

    it("leaves the head in place when the reply errored while the withdrawal was out", async () => {
        const queue = queueOf([{ attachments: [], id: "a", steer, text: "go left" }]);
        let hasError = false;

        expect(
            await takeNextToSend({
                ...queue,
                canSend: () => !hasError,
                withdraw: async () => {
                    hasError = true;

                    return "withdrawn";
                },
            }),
        ).toStrictEqual({ kind: "blocked" });
        expect(queue.items.map((entry) => entry.id)).toStrictEqual(["a"]);
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

describe("hidden characters in queued prompts", () => {
    const tagged = "a\u{E0041}b\u{202E}c";

    it("never queues them", () => {
        expect(enqueuePrompt(EMPTY_PROMPT_QUEUE, { attachments: [], id: "1", text: tagged }).items[0]?.text).toBe("abc");
        expect(prependPrompt(EMPTY_PROMPT_QUEUE, { attachments: [], id: "1", text: tagged }).items[0]?.text).toBe("abc");
    });

    it("drops them from a queue restored after a reload", () => {
        const restored = restorePromptQueue(JSON.stringify({ items: [{ id: "1", text: tagged }] }));

        expect(restored?.items[0]?.text).toBe("abc");
    });
});

describe("editing a queued prompt", () => {
    it("replaces the text in place, keeping the place, and gives the changed message a new id", () => {
        const state = { items: [item("a"), item("b")], paused: false };

        const edited = editQueuedPrompt(state, "b", "rewritten", "fresh");

        expect(edited.items.map((entry) => [entry.id, entry.text])).toEqual([
            ["a", "text a"],
            ["fresh", "rewritten"],
        ]);
    });

    it("keeps the id when the text is unchanged, so a retry of the same message stays one message", () => {
        const edited = editQueuedPrompt({ items: [item("a")], paused: false }, "a", "text a", "fresh");

        expect(edited.items[0]?.id).toBe("a");
    });

    it("strips hidden characters from the new text, as enqueueing does", () => {
        const edited = editQueuedPrompt({ items: [item("a")], paused: false }, "a", "abc\u{200B}", "fresh");

        expect(edited.items[0]?.text).toBe("abc");
    });

    it("keeps the text when the new text is only hidden characters, rather than emptying the message", () => {
        const edited = editQueuedPrompt({ items: [item("a")], paused: false }, "a", "\u{200B}\u{200B}", "fresh");

        expect(edited.items[0]).toEqual(item("a"));
    });

    it("leaves a steered message as it is, since it is already in the reply", () => {
        const steered = { ...item("s"), steer: { id: "steer-1", streamId: "stream-1" } };

        expect(editQueuedPrompt({ items: [steered], paused: false }, "s", "changed", "fresh").items[0]?.text).toBe("text s");
    });
});

describe("reordering queued prompts", () => {
    const four = (): PromptQueueState<never> => {
        return { items: [item("a"), item("b"), item("c"), item("d")], paused: false };
    };
    const ids = (state: PromptQueueState<never>) => state.items.map((entry) => entry.id);
    const movedTo = (id: string, to: number) => ids(moveQueuedPrompt(four(), id, to));
    const stepped = (id: string, direction: -1 | 1) => ids(stepQueuedPrompt(four(), id, direction));

    it("sends the third message first once it is moved to the top", () => {
        const moved = moveQueuedPrompt(four(), "c", 0);
        const { next, state } = dequeuePrompt(moved);

        expect(next?.id).toBe("c");
        expect(ids(state)).toEqual(["a", "b", "d"]);
    });

    it("moves to any index and keeps the rest in order", () => {
        expect(movedTo("a", 2)).toEqual(["b", "c", "a", "d"]);
        expect(movedTo("d", 1)).toEqual(["a", "d", "b", "c"]);
    });

    it("moves one place up or down and keeps the rest in order", () => {
        expect(stepped("c", -1)).toEqual(["a", "c", "b", "d"]);
        expect(stepped("b", 1)).toEqual(["a", "c", "b", "d"]);
    });

    it("leaves the queue as it is at the edges, for an unknown id and for a move in place", () => {
        const state = four();

        expect(stepQueuedPrompt(state, "a", -1)).toBe(state);
        expect(stepQueuedPrompt(state, "d", 1)).toBe(state);
        expect(moveQueuedPrompt(state, "zzz", 0)).toBe(state);
        expect(moveQueuedPrompt(state, "b", 1)).toBe(state);
    });

    it("clamps an index outside the queue", () => {
        expect(movedTo("a", 99)).toEqual(["b", "c", "d", "a"]);
        expect(movedTo("d", -5)).toEqual(["d", "a", "b", "c"]);
    });

    it("keeps a pending steer in its place", () => {
        const state: PromptQueueState<never> = {
            items: [item("a"), { ...item("s"), steer: { id: "s1", pending: true, streamId: "x" } }, item("c")],
            paused: false,
        };

        expect(moveQueuedPrompt(state, "s", 0)).toBe(state);
        expect(moveQueuedPrompt(state, "c", 1)).toBe(state);
    });

    it("keeps an accepted steer in its place too, since the reply reads steers in the order they were sent", () => {
        const state: PromptQueueState<never> = {
            items: [item("a"), { ...item("s"), steer: { id: "s1", streamId: "x" } }, item("c")],
            paused: false,
        };

        expect(moveQueuedPrompt(state, "s", 2)).toBe(state);
        expect(moveQueuedPrompt(state, "c", 0)).toBe(state);
    });

    it("refuses a move that passes over a pending steer, even when neither end is the steer", () => {
        const state: PromptQueueState<never> = {
            items: [item("a"), { ...item("s"), steer: { id: "s1", pending: true, streamId: "x" } }, item("c")],
            paused: false,
        };

        expect(moveQueuedPrompt(state, "a", 2)).toBe(state);
        expect(moveQueuedPrompt(state, "c", 0)).toBe(state);
    });

    it("keeps the paused flag and survives a save and restore in the new order", () => {
        const moved = { ...moveQueuedPrompt(four(), "c", 0), paused: true };
        const restored = restorePromptQueue(serializePromptQueue(moved));

        expect(restored && ids(restored)).toEqual(["c", "a", "b", "d"]);
    });
});

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
    const shiftFrom =
        <T>(items: T[]) =>
        () =>
            items.shift();

    it("sends a plain prompt without withdrawing anything", async () => {
        const withdraw = vi.fn();

        expect(await takeNextToSend(shiftFrom([{ attachments: [], id: "a", text: "hi" }]), withdraw)).toStrictEqual({
            kind: "send",
            prompt: { attachments: [], id: "a", text: "hi" },
        });
        expect(withdraw).not.toHaveBeenCalled();
    });

    it("sends a steer the reply never took, or whose stream is gone", async () => {
        for (const outcome of ["withdrawn", "unknown"] as const) {
            const prompt = { attachments: [], id: "a", steer, text: "go left" };

            expect(await takeNextToSend(shiftFrom([prompt]), async () => outcome)).toStrictEqual({ kind: "send", prompt });
        }
    });

    it("drops a steer the reply already took, and sends the prompt after it", async () => {
        const items = [
            { attachments: [], id: "a", steer, text: "go left" },
            { attachments: [], id: "b", text: "then this" },
        ];

        expect(await takeNextToSend(shiftFrom(items), async () => "delivered")).toStrictEqual({
            kind: "send",
            prompt: { attachments: [], id: "b", text: "then this" },
        });
        expect(items).toHaveLength(0);
    });

    it("hands a steer back when its withdrawal fails, so it is neither lost nor sent twice", async () => {
        const prompt = { attachments: [], id: "a", steer, text: "go left" };

        expect(
            await takeNextToSend(shiftFrom([prompt]), async () => {
                throw new Error("offline");
            }),
        ).toStrictEqual({ kind: "requeue", prompt });
    });

    it("returns nothing for a queue that only held delivered steers", async () => {
        expect(await takeNextToSend(shiftFrom([{ attachments: [], id: "a", steer, text: "go left" }]), async () => "delivered")).toBeUndefined();
    });
});

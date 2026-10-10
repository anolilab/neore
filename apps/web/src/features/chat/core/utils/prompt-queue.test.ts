import { describe, expect, it } from "vitest";

import type { PromptQueueState } from "./prompt-queue";
import { decideAutoSend, dequeuePrompt, EMPTY_PROMPT_QUEUE, enqueuePrompt, removeQueuedPrompt, restorePromptQueue, serializePromptQueue } from "./prompt-queue";

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

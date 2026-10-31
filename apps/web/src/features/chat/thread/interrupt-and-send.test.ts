import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";

import interruptAndSend from "./interrupt-and-send";

const THREAD_ID = "thread-1";

describe("interruptAndSend", () => {
    beforeEach(() => {
        usePromptQueueStore.setState({ queues: {} });
        usePromptQueueStore.getState().hydrate(THREAD_ID);
    });

    it("queues the text ahead of what is waiting, lifts a pause, then stops the reply", () => {
        const { enqueue, setPaused } = usePromptQueueStore.getState();
        const order: string[] = [];
        const cancelStream = vi.fn(async () => {
            order.push(`cancel (paused: ${usePromptQueueStore.getState().queues[THREAD_ID]?.paused})`);
        });

        enqueue(THREAD_ID, { attachments: [], text: "older" });
        setPaused(THREAD_ID, true);

        interruptAndSend(THREAD_ID, "instead, do this", cancelStream);

        const queue = usePromptQueueStore.getState().queues[THREAD_ID];

        expect(queue?.items.map((item) => item.text)).toEqual(["instead, do this", "older"]);
        expect(queue?.items[0]?.steer).toBeUndefined();
        expect(queue?.paused).toBe(false);
        expect(cancelStream).toHaveBeenCalledTimes(1);
        expect(order).toEqual(["cancel (paused: false)"]);
    });
});

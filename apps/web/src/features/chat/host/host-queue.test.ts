import { describe, expect, it } from "vitest";

import { canInterruptAndSend, canSendQueueHead, shouldQueueMessage } from "./host-queue";

const idle = { blocked: false, loaded: true, paused: false, pendingStart: false, queued: 1, running: false, sending: false };

describe("queueing a message during a host turn", () => {
    it("queues while a turn runs, and while the queue already holds messages", () => {
        expect(shouldQueueMessage({ pendingStart: false, queued: 0, running: true })).toBe(true);
        expect(shouldQueueMessage({ pendingStart: false, queued: 2, running: false })).toBe(true);
    });

    it("queues while the last queued send is waiting for its turn to start", () => {
        expect(shouldQueueMessage({ pendingStart: true, queued: 0, running: false })).toBe(true);
    });

    it("sends at once when nothing runs and nothing waits", () => {
        expect(shouldQueueMessage({ pendingStart: false, queued: 0, running: false })).toBe(false);
    });

    it("offers interrupt-and-send through the restart steer, which the composer enforces", () => {
        expect(canInterruptAndSend()).toBe(true);
    });
});

describe("sending the head of the queue", () => {
    it("sends the head when the thread is idle", () => {
        expect(canSendQueueHead(idle)).toBe(true);
    });

    it("waits while a turn runs, while a send is in flight, and while the queue starts a turn", () => {
        expect(canSendQueueHead({ ...idle, running: true })).toBe(false);
        expect(canSendQueueHead({ ...idle, sending: true })).toBe(false);
        expect(canSendQueueHead({ ...idle, pendingStart: true })).toBe(false);
    });

    it("stays put when paused after a refusal, or when the session has ended", () => {
        expect(canSendQueueHead({ ...idle, paused: true })).toBe(false);
        expect(canSendQueueHead({ ...idle, blocked: true })).toBe(false);
    });

    it("has nothing to send from an empty queue", () => {
        expect(canSendQueueHead({ ...idle, queued: 0 })).toBe(false);
    });

    it("waits until the session and the stream have loaded, rather than reading them as idle", () => {
        expect(canSendQueueHead({ ...idle, loaded: false })).toBe(false);
    });
});

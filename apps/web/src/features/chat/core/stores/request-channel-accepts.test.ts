import { describe, expect, it, vi } from "vitest";

import { createRequestChannel } from "./request-channel-store";

interface Jump {
    messageId: string;
    threadId: string;
}

describe("request channel with an accepts filter", () => {
    it("leaves a request for another thread for the consumer that accepts it", () => {
        expect.hasAssertions();

        const channel = createRequestChannel<Jump>();
        // An earlier list (a background split pane) that would take anything: under the old behaviour it took the request first.
        const unfocusedPane = vi.fn();
        const focusedPane = vi.fn();

        const unsubscribeUnfocused = channel.consume(unfocusedPane, (payload) => payload.threadId === "thread-unfocused");
        const unsubscribeFocused = channel.consume(focusedPane, (payload) => payload.threadId === "thread-focused");

        channel.request({ messageId: "m1", threadId: "thread-focused" });

        expect(unfocusedPane).not.toHaveBeenCalled();
        expect(focusedPane).toHaveBeenCalledWith({ messageId: "m1", threadId: "thread-focused" });

        unsubscribeUnfocused();
        unsubscribeFocused();
    });

    it("keeps a request nobody accepts pending until a matching consumer mounts", () => {
        expect.hasAssertions();

        const channel = createRequestChannel<Jump>();
        const other = vi.fn();

        channel.request({ messageId: "m2", threadId: "thread-later" });
        const unsubscribe = channel.consume(other, (payload) => payload.threadId === "thread-open");

        expect(other).not.toHaveBeenCalled();
        expect(channel.store.getState().pending).not.toBeNull();

        const later = vi.fn();
        const unsubscribeLater = channel.consume(later, (payload) => payload.threadId === "thread-later");

        expect(later).toHaveBeenCalledWith({ messageId: "m2", threadId: "thread-later" });

        unsubscribe();
        unsubscribeLater();
    });

    it("delivers a request without an accepts filter to the first consumer, as before", () => {
        expect.hasAssertions();

        const channel = createRequestChannel<Jump>();
        const first = vi.fn();
        const second = vi.fn();

        const unsubscribeFirst = channel.consume(first);
        const unsubscribeSecond = channel.consume(second);

        channel.request({ messageId: "m3", threadId: "any" });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();

        unsubscribeFirst();
        unsubscribeSecond();
    });
});

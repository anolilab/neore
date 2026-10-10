import { describe, expect, it, vi } from "vitest";

import { createRequestChannel } from "./request-channel-store";

describe(createRequestChannel, () => {
    it("delivers a request made before the consumer subscribed", () => {
        const channel = createRequestChannel<string>();
        const handler = vi.fn();

        channel.request("early");
        const unsubscribe = channel.consume(handler);

        expect(handler).toHaveBeenCalledExactlyOnceWith("early");
        expect(channel.store.getState().pending).toBeNull();

        unsubscribe();
    });

    it("delivers each request once, to the first consumer, even for identical payloads", () => {
        const channel = createRequestChannel<{ id: number }>();
        const first = vi.fn();
        const second = vi.fn();
        const payload = { id: 1 };

        const unsubscribeFirst = channel.consume(first);
        const unsubscribeSecond = channel.consume(second);

        channel.request(payload);
        channel.request(payload);

        expect(first).toHaveBeenCalledTimes(2);
        expect(second).not.toHaveBeenCalled();

        unsubscribeFirst();
        unsubscribeSecond();
    });

    it("stops delivering after unsubscribe and keeps the request pending", () => {
        const channel = createRequestChannel<string>();
        const handler = vi.fn();

        channel.consume(handler)();
        channel.request("later");

        expect(handler).not.toHaveBeenCalled();
        expect(channel.store.getState().pending).toStrictEqual({ payload: "later" });
    });
});

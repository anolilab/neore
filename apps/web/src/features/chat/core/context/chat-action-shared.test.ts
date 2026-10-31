import { describe, expect, it } from "vitest";

import { stopTarget } from "./chat-action-shared";

const message = { messageId: "m1", threadId: "t1" };

describe("stopTarget", () => {
    it("names the message when this provider is streaming one", () => {
        expect(stopTarget({ activeStreamId: "s1", streamingMessage: message })).toBe("message");
        expect(stopTarget({ activeStreamId: null, streamingMessage: message })).toBe("message");
    });

    it("falls back to the thread when a live stream has no message to name (a paused run after a reload)", () => {
        expect(stopTarget({ activeStreamId: "s1", streamingMessage: null })).toBe("thread");
    });

    it("has nothing to stop without either", () => {
        expect(stopTarget({ activeStreamId: null, streamingMessage: null })).toBe("none");
    });
});

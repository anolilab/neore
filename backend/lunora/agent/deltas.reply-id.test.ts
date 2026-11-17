import { describe, expect, it } from "vitest";

import { blankUIMessage } from "./deltas";
import type { StreamMessage } from "./validators";

const streamMessage = (overrides: Partial<StreamMessage>): StreamMessage =>
    ({ order: 1, status: "streaming", stepOrder: 0, streamId: "stream-1", ...overrides }) as StreamMessage;

describe("blankUIMessage", () => {
    it("names the reply by the run that writes it, the same id its saved rows carry", () => {
        const row = blankUIMessage(streamMessage({ runStreamId: "run-7" }), "thread-1");

        expect((row as { replyId?: string }).replyId).toBe("run-7");
    });

    it("names no reply when the run's id is not known", () => {
        const row = blankUIMessage(streamMessage({}), "thread-1");

        expect((row as { replyId?: string }).replyId).toBeUndefined();
    });
});

/**
 * A reply the browser streamed from a local model server is flagged `localReply`
 * (`providerMetadata.neore.runtime`, written by `chat/lib/local-turn.ts`), so the
 * thread can show its cause and offer Continue. A gateway reply is not flagged.
 */
import { describe, expect, it } from "vitest";

import { toUIMessages } from "./ui-messages";

const failedReply = (providerMetadata: unknown) =>
    ({
        _creationTime: 1,
        _id: "m1",
        message: { content: [{ text: "partial", type: "text" }], role: "assistant" },
        order: 1,
        providerMetadata,
        status: "failed",
        stepOrder: 1,
        threadId: "t1",
        tool: false,
    }) as never;

describe("toUIMessages: local replies", () => {
    it("flags a reply saved from a local model server", () => {
        const [message] = toUIMessages([failedReply({ neore: { billed: false, runtime: "local-browser" } })]);

        expect(message?.localReply).toBe(true);
    });

    it("does not flag a gateway reply", () => {
        const [message] = toUIMessages([failedReply({ neore: { billed: true } })]);

        expect(message).not.toHaveProperty("localReply");
    });
});

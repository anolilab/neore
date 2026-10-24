import { describe, expect, it } from "vitest";

import { countPromptTextChars, estimateCancelledUsage } from "../lib/cancelled-usage.js";

describe(estimateCancelledUsage, () => {
    it("estimates nothing from nothing", () => {
        expect(estimateCancelledUsage({ emittedChars: 0, promptChars: 0, reasoningChars: 0 })).toStrictEqual({
            cachedTokens: 0,
            completionTokens: 0,
            promptTokens: 0,
            reasoningTokens: 0,
        });
    });

    it("estimates four characters per token, rounded up", () => {
        // Completion is the total output, reasoning included: ceil((40 + 9) / 4) = 13.
        expect(estimateCancelledUsage({ emittedChars: 40, promptChars: 400, reasoningChars: 9 })).toStrictEqual({
            cachedTokens: 0,
            completionTokens: 13,
            promptTokens: 100,
            reasoningTokens: 3,
        });
    });
});

describe(countPromptTextChars, () => {
    it("counts string contents, text parts and the system prompt, nothing else", () => {
        const messages = [
            { content: "system!", role: "system" },
            {
                content: [
                    { text: "hello", type: "text" },
                    { data: "AAAA", mediaType: "image/png", type: "file" },
                ],
                role: "user",
            },
            { content: [{ input: { q: "x" }, toolCallId: "c1", toolName: "search", type: "tool-call" }], role: "assistant" },
        ];

        expect(countPromptTextChars(messages, "sys")).toBe(3 + 7 + 5);
    });
});

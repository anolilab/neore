import { describe, expect, it } from "vitest";

import { countPromptTextChars, estimateCancelledUsage } from "../lib/cancelled-usage.js";
import { deferWaitUntil } from "../lib/deferred-wait-until.js";

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

describe(deferWaitUntil, () => {
    it("registers a pending promise at once and settles it with the handed work", async () => {
        const registered: Promise<unknown>[] = [];
        const settle = deferWaitUntil({
            waitUntil: (promise) => {
                registered.push(promise);
            },
        });
        let isDone = false;

        const watcher = registered[0]!.then(() => {
            isDone = true;

            return isDone;
        });

        expect(registered).toHaveLength(1);
        await Promise.resolve();
        expect(isDone).toBe(false);

        settle(
            new Promise((resolve) => {
                setTimeout(resolve, 5);
            }),
        );
        await watcher;
        expect(isDone).toBe(true);
    });

    it("swallows a failure of the handed work", async () => {
        const registered: Promise<unknown>[] = [];
        const settle = deferWaitUntil({
            waitUntil: (promise) => {
                registered.push(promise);
            },
        });

        settle(Promise.reject(new Error("boom")));
        await expect(registered[0]).resolves.toBeUndefined();
    });
});

/**
 * A saved browser result keeps its human check's reply key for the card (`humanCheck.run`), and no model is shown it:
 * `docsToModelMessages` drops it from the saved row itself, with no tool formatter involved. That approval saves the raw
 * result is checked in `tool-approval.model-output.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { docsToModelMessages } from "../mapping";

const HUMAN_CHECK = { browserId: "browser-1", checkId: "check-1", run: "reply-1", site: "shop.example.com", status: "asked" };
const RESULT = { humanCheck: HUMAN_CHECK, success: false, title: "Just a moment", url: "https://shop.example.com/" };

/** A tool row an approval saved: the browser's raw result, marked as such. */
const SAVED = {
    content: [
        { approvalId: "approval-1", approved: true, type: "tool-approval-response" },
        {
            output: { type: "json", value: RESULT },
            providerOptions: { neore: { rawToolResult: true } },
            toolCallId: "call-1",
            toolName: "browser",
            type: "tool-result",
        },
    ],
    role: "tool",
};

describe(docsToModelMessages, () => {
    it("drops a saved browser result's reply key from what the model reads", () => {
        expect.assertions(2);

        const [modelMessage] = docsToModelMessages([{ _id: "message-2", message: SAVED } as never]);
        const modelResult = (modelMessage!.content as { output?: { value: typeof RESULT }; type: string }[]).find((part) => part.type === "tool-result");

        expect(modelResult?.output?.value.humanCheck).toStrictEqual({ browserId: "browser-1", checkId: "check-1", site: "shop.example.com", status: "asked" });
        // The row itself keeps it for the card.
        expect(SAVED.content[1]).toMatchObject({ output: { value: { humanCheck: { run: "reply-1" } } } });
    });
});

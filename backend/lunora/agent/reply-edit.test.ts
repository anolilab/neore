import { describe, expect, it } from "vitest";

import type { ReplyRow } from "./reply-edit";
import { replyTextOf, rewriteReplyText } from "./reply-edit";

const toolCall = { input: {}, toolCallId: "c1", toolName: "search", type: "tool-call" };
const toolResult = { output: { type: "text", value: "hits" }, toolCallId: "c1", toolName: "search", type: "tool-result" };

describe("rewriteReplyText", () => {
    it("replaces the only text part and keeps tool calls and reasoning in place", () => {
        const rows: ReplyRow[] = [{ content: [{ text: "Old answer", type: "text" }, { text: "pondering", type: "reasoning" }, toolCall], role: "assistant" }];

        expect(rewriteReplyText(rows, "New answer")).toStrictEqual([
            [{ text: "New answer", type: "text" }, { text: "pondering", type: "reasoning" }, toolCall],
        ]);
    });

    it("puts the text in the last text part, after the tool calls, and drops the earlier ones", () => {
        const rows: ReplyRow[] = [
            { content: [{ text: "Let me check.", type: "text" }, toolCall], role: "assistant" },
            { content: [toolResult], role: "tool" },
            { content: [{ text: "Here it is.", type: "text" }], role: "assistant" },
        ];

        expect(rewriteReplyText(rows, "Revised.")).toStrictEqual([[toolCall], undefined, [{ text: "Revised.", type: "text" }]]);
    });

    it("leaves tool rows and rows without text untouched", () => {
        const rows: ReplyRow[] = [
            { content: [toolCall], role: "assistant" },
            { content: [toolResult], role: "tool" },
            { content: [{ text: "Answer", type: "text" }], role: "assistant" },
        ];

        const [first, second, third] = rewriteReplyText(rows, "Changed") ?? [];

        expect(first).toBeUndefined();
        expect(second).toBeUndefined();
        expect(third).toStrictEqual([{ text: "Changed", type: "text" }]);
    });

    it("keeps a string body a string when it is the one carrying the text", () => {
        expect(rewriteReplyText([{ content: "Old", role: "assistant" }], "New")).toStrictEqual(["New"]);
    });

    it("writes nothing when the text is unchanged", () => {
        const rows: ReplyRow[] = [
            { content: [{ text: "Same", type: "text" }], role: "assistant" },
            { content: [{ text: "Also", type: "text" }], role: "assistant" },
        ];

        expect(rewriteReplyText(rows, replyTextOf(rows))).toStrictEqual([undefined, undefined]);
    });

    it("refuses a reply that has no text part", () => {
        expect(rewriteReplyText([{ content: [toolCall], role: "assistant" }], "anything")).toBeNull();
        expect(rewriteReplyText([{ content: [{ text: "user says", type: "text" }], role: "user" }], "anything")).toBeNull();
    });
});

describe("replyTextOf", () => {
    it("joins the assistant text parts, skipping tool rows", () => {
        const rows: ReplyRow[] = [
            { content: [{ text: "First", type: "text" }, toolCall], role: "assistant" },
            { content: [toolResult], role: "tool" },
            { content: [{ text: "Second", type: "text" }], role: "assistant" },
        ];

        expect(replyTextOf(rows)).toBe("First Second");
    });
});

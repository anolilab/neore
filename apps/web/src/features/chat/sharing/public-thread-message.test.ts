import { describe, expect, it } from "vitest";

import type { PublicThreadMessage } from "./public-thread-message";
import { formatToolName, toPublicThreadRenderable } from "./public-thread-message";

describe("toPublicThreadRenderable", () => {
    it("routes tool and attachment parts out of the rendered message", () => {
        const source: PublicThreadMessage = {
            createdAt: 1,
            id: "m1",
            parts: [
                { mediaType: "image/png", type: "attachment" },
                { toolName: "web_search", type: "tool" },
                { text: "Answer", type: "text" },
                { title: "Docs", type: "source-url", url: "https://example.com" },
                { mediaType: "image/png", type: "file", url: "https://files.example.com/a.png" },
            ],
            role: "assistant",
        };

        const { attachments, message, tools } = toPublicThreadRenderable(source);

        expect(attachments).toEqual(["image/png"]);
        expect(tools).toEqual(["web_search"]);
        expect(message).toEqual({
            _creationTime: 1,
            id: "m1",
            parts: [
                { text: "Answer", type: "text" },
                { sourceId: "m1-source-3", title: "Docs", type: "source-url", url: "https://example.com" },
                { filename: undefined, mediaType: "image/png", type: "file", url: "https://files.example.com/a.png" },
            ],
            role: "assistant",
            status: "success",
        });
    });
});

describe("formatToolName", () => {
    it("turns identifiers into words", () => {
        expect(formatToolName("web_search")).toBe("web search");
        expect(formatToolName("github__list-issues")).toBe("github list issues");
    });
});

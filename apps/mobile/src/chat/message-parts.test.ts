import { describe, expect, it } from "vitest";

import { displayTextOf, shareTextOf } from "./message-parts";
import { shareableMessageText, shareLabel } from "./share-message";

describe("message parts", () => {
    it("shows a label for an attachment, and shares nothing for it", () => {
        const parts = [{ type: "image" }];

        expect(displayTextOf(parts)).toBe("[Attachment]");
        expect(shareTextOf(parts)).toBe("");
        expect(shareableMessageText({ text: shareTextOf(parts) })).toBeUndefined();
    });

    it("shares the text of a mixed message without the attachment label", () => {
        const parts = [{ text: "Look at this", type: "text" }, { type: "file" }];

        expect(displayTextOf(parts)).toBe("Look at this[Attachment]");
        expect(shareTextOf(parts)).toBe("Look at this");
    });

    it("shares the typed prompt of a message with attached page, and never the page", () => {
        const parts = [
            { providerMetadata: { neore: { pageContext: { title: "Page" } } }, text: "Page title: Page\nSelected text: secret", type: "text" },
            { text: "Summarise this", type: "text" },
        ];

        expect(shareTextOf(parts)).toBe("Summarise this");
    });

    it("joins adjacent text parts with a space, as the server does", () => {
        expect(shareTextOf([{ text: "Hello", type: "text" }, { text: "world", type: "text" }])).toBe("Hello world");
    });

    it("skips an empty text part", () => {
        expect(shareTextOf([{ text: "first", type: "text" }, { text: "", type: "text" }, { text: "second", type: "text" }])).toBe("first second");
    });

    it("labels a mixed message by the text it shares, not by its attachment label", () => {
        const parts = [{ type: "image" }, { text: "Look at this", type: "text" }];

        expect(shareLabel({ role: "user", text: shareTextOf(parts) })).toBe("Share your message: Look at this");
    });
});

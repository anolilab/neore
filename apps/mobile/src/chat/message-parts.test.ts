import { describe, expect, it } from "vitest";

import { displayTextOf, shareTextOf } from "./message-parts";
import { shareableMessageText } from "./share-message";

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

    it("joins the text parts of a message that has no attachment", () => {
        expect(shareTextOf([{ text: "first ", type: "text" }, { text: "second", type: "text" }])).toBe("first second");
    });
});

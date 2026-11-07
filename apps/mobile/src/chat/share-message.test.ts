import { describe, expect, it } from "vitest";

import { shareableMessageText, shareLabel } from "./share-message";

describe("shareableMessageText", () => {
    it("returns the message text as written, indentation included", () => {
        expect(shareableMessageText({ text: "  Hello there.\n" })).toBe("  Hello there.\n");
    });

    it("keeps the inner line breaks of a multi-line reply", () => {
        expect(shareableMessageText({ text: "first\n\nsecond" })).toBe("first\n\nsecond");
    });

    it("returns undefined for an empty or whitespace-only message", () => {
        expect(shareableMessageText({ text: "" })).toBeUndefined();
        expect(shareableMessageText({ text: " \n\t " })).toBeUndefined();
    });
});

describe("shareLabel", () => {
    it("names the speaker and the start of the message", () => {
        expect(shareLabel({ role: "user", text: "Summarise the\nlast meeting" })).toBe("Share your message: Summarise the last meeting");
        expect(shareLabel({ role: "assistant", text: "Here it is." })).toBe("Share reply: Here it is.");
    });

    it("does not split an emoji at the cut", () => {
        const label = shareLabel({ role: "assistant", text: `${"a".repeat(39)}😀 and more` });

        expect(label).toBe(`Share reply: ${"a".repeat(39)}😀…`);
    });

    it("cuts a long message to a short preview", () => {
        const label = shareLabel({ role: "assistant", text: "a".repeat(100) });

        expect(label).toBe(`Share reply: ${"a".repeat(40)}…`);
    });
});

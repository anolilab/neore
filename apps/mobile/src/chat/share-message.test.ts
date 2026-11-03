import { describe, expect, it } from "vitest";

import { shareableMessageText } from "./share-message";

describe("shareableMessageText", () => {
    it("returns the message text without surrounding whitespace", () => {
        expect(shareableMessageText({ text: "  Hello there.\n" })).toBe("Hello there.");
    });

    it("keeps the inner line breaks of a multi-line reply", () => {
        expect(shareableMessageText({ text: "first\n\nsecond" })).toBe("first\n\nsecond");
    });

    it("returns undefined for an empty or whitespace-only message", () => {
        expect(shareableMessageText({ text: "" })).toBeUndefined();
        expect(shareableMessageText({ text: " \n\t " })).toBeUndefined();
    });
});

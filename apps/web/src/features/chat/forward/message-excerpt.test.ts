import { describe, expect, it } from "vitest";

import { messageExcerpt } from "./message-excerpt";

describe(messageExcerpt, () => {
    it("collapses whitespace onto one line", () => {
        expect(messageExcerpt("  Hello\n\n  world  ")).toBe("Hello world");
    });

    it("cuts a long message with an ellipsis", () => {
        expect(messageExcerpt("abcdefghij", 6)).toBe("abcde…");
        expect(messageExcerpt("abcdef", 6)).toBe("abcdef");
    });

    it("is empty for an empty message", () => {
        expect(messageExcerpt(" \n ")).toBe("");
    });
});

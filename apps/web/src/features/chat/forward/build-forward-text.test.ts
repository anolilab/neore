import { describe, expect, it } from "vitest";

import { buildForwardText, toBlockquote } from "./build-forward-text";

const NOTICE = "Forwarded content was shortened.";

describe(toBlockquote, () => {
    it("prefixes every line, blank ones included", () => {
        expect(toBlockquote("one\n\ntwo")).toBe("> one\n>\n> two");
    });
});

describe(buildForwardText, () => {
    it("quotes each message under its author, after the skill command and note", () => {
        const text = buildForwardText(
            [
                { author: "You", text: "What is 2+2?" },
                { author: "Assistant", text: "It is 4.\n\nAlways." },
            ],
            { note: "Check this", skillSlug: "math-tutor", truncatedNotice: NOTICE },
        );

        expect(text).toBe("/math-tutor Check this\n\n> **You:**\n> What is 2+2?\n\n> **Assistant:**\n> It is 4.\n>\n> Always.");
    });

    it("works without a skill or note and skips empty messages", () => {
        expect(
            buildForwardText(
                [
                    { author: "Ada", text: " ".repeat(3) },
                    { author: "Ada", text: "Hi" },
                ],
                { truncatedNotice: NOTICE },
            ),
        ).toBe("> **Ada:**\n> Hi");
    });

    it("escapes markdown in the author label", () => {
        expect(buildForwardText([{ author: "*bold*_agent_", text: "x" }], { truncatedNotice: NOTICE })).toBe("> **\\*bold\\*\\_agent\\_:**\n> x");
    });

    it("cuts the quotes at the character cap and says so", () => {
        const text = buildForwardText(
            [
                { author: "You", text: "a".repeat(8) },
                { author: "You", text: "b".repeat(8) },
                { author: "You", text: "c".repeat(8) },
            ],
            { maxChars: 12, truncatedNotice: NOTICE },
        );

        expect(text).toBe(`> **You:**\n> aaaaaaaa\n\n> **You:**\n> bbbb…\n\n_${NOTICE}_`);
    });
});

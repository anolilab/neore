import { describe, expect, it } from "vitest";

import { documentTextPart } from "./attached-text";
import { FILE_ONLY_PROMPT, fileOnlyPromptPart, firstUserPromptText } from "./first-user-prompt";

describe("firstUserPromptText", () => {
    it("takes the first user message that has text", () => {
        const rows = [
            { message: { content: "", role: "user" } },
            { message: { content: "Plan a trip to Lisbon", role: "user" } },
            { message: { content: "Sure", role: "assistant" } },
            { message: { content: "A later question", role: "user" } },
        ];

        expect(firstUserPromptText(rows)).toBe("Plan a trip to Lisbon");
    });

    it("reads only the text parts of a structured message", () => {
        const rows = [
            {
                message: {
                    content: [
                        { image: "data:...", type: "image" },
                        { text: "What is in this photo?", type: "text" },
                        { text: "Be brief.", type: "text" },
                    ],
                    role: "user",
                },
            },
        ];

        expect(firstUserPromptText(rows)).toBe("What is in this photo? Be brief.");
    });

    it("ignores assistant and tool rows", () => {
        const rows = [
            { message: { content: "Hidden reply", role: "assistant" } },
            { message: { content: [{ text: "x", type: "tool-result" }], role: "tool" } },
        ];

        expect(firstUserPromptText(rows)).toBeUndefined();
    });

    it("caps a long prompt and returns nothing for an empty window", () => {
        expect(firstUserPromptText([])).toBeUndefined();
        expect(firstUserPromptText([{ message: { content: "a".repeat(5000), role: "user" } }])).toHaveLength(2000);
    });

    it("cuts by code point, so a surrogate pair is never split at the limit", () => {
        const text = firstUserPromptText([{ message: { content: "🙂".repeat(2500), role: "user" } }]);

        expect([...(text ?? "")]).toHaveLength(2000);
        expect([...(text ?? "")].every((character) => character === "🙂")).toBe(true);
    });
});

describe("reading a long structured prompt for a title", () => {
    it("stops reading its text parts once the title's limit is reached, instead of reading every part", () => {
        let reads = 0;
        const parts = Array.from({ length: 10_000 }, () => {
            return {
                get text() {
                    reads += 1;

                    return "x".repeat(1000);
                },
                type: "text",
            };
        });

        const text = firstUserPromptText([{ message: { content: parts, role: "user" } }]);

        expect(text).toHaveLength(2000);
        expect(reads).toBeLessThan(100);
    });

    it("keeps the first characters of a prompt that starts with whitespace, and drops the whitespace before them", () => {
        const text = firstUserPromptText([{ message: { content: `${" ".repeat(50)}Plan a trip`, role: "user" } }]);

        expect(text).toBe("Plan a trip");
    });
});

describe("a message with attached text and a question", () => {
    const pageMarked = (text: string) => {
        return { providerOptions: { neore: { pageContext: { kind: "page" } } }, text, type: "text" };
    };

    it("takes the typed question, not the attached document's text, when both are in the message", () => {
        const content = [documentTextPart("notes.pdf", "Quarterly figures ".repeat(200)), { text: "What is the total?", type: "text" }];

        expect(firstUserPromptText([{ message: { content, role: "user" } }])).toBe("What is the total?");
    });

    it("takes the typed question, not an attached browser page, when both are in the message", () => {
        const content = [pageMarked("Some page text ".repeat(200)), { text: "Summarise this page", type: "text" }];

        expect(firstUserPromptText([{ message: { content, role: "user" } }])).toBe("Summarise this page");
    });

    it("takes the question typed before an attachment in one string", () => {
        const content = "What is this?\n[Attached Document]\n\nExtracted text ".repeat(1);

        expect(firstUserPromptText([{ message: { content, role: "user" } }])).toBe("What is this?");
    });

    it("takes the attached document, not the text sent for a file with no question", () => {
        const content = [documentTextPart("notes.pdf", "Quarterly figures"), fileOnlyPromptPart()];

        expect(firstUserPromptText([{ message: { content, role: "user" } }])).toBe("[Document: notes.pdf]\n\nQuarterly figures");
    });

    it("takes the same words as the question when the person typed them", () => {
        const content = [documentTextPart("notes.pdf", "Quarterly figures"), { text: FILE_ONLY_PROMPT, type: "text" }];

        expect(firstUserPromptText([{ message: { content, role: "user" } }])).toBe(FILE_ONLY_PROMPT);
    });

    it("keeps the text sent for a file when nothing was extracted from it", () => {
        expect(firstUserPromptText([{ message: { content: [fileOnlyPromptPart()], role: "user" } }])).toBe(FILE_ONLY_PROMPT);
    });

    it("keeps the attached text when the message has no question", () => {
        const content = [documentTextPart("notes.pdf", "Quarterly figures")];

        expect(firstUserPromptText([{ message: { content, role: "user" } }])).toBe("[Document: notes.pdf]\n\nQuarterly figures");
    });
});

describe("whitespace in a prompt", () => {
    it("treats a message that is only whitespace as no prompt", () => {
        expect(firstUserPromptText([{ message: { content: " ".repeat(20_000), role: "user" } }])).toBeUndefined();
        expect(firstUserPromptText([{ message: { content: [{ text: " \n\t ".repeat(5000), type: "text" }], role: "user" } }])).toBeUndefined();
    });

    it("finds a real prompt after more leading whitespace than the read budget, in a string and in parts", () => {
        expect(firstUserPromptText([{ message: { content: `${" ".repeat(9000)}Plan a trip`, role: "user" } }])).toBe("Plan a trip");
        expect(
            firstUserPromptText([
                {
                    message: {
                        content: [
                            { text: " ".repeat(9000), type: "text" },
                            { text: "Plan a trip", type: "text" },
                        ],
                        role: "user",
                    },
                },
            ]),
        ).toBe("Plan a trip");
    });
});

import { describe, expect, it } from "vitest";

import { firstUserPromptText } from "./first-user-prompt";

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
});

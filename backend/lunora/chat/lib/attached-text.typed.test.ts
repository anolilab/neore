import { describe, expect, it } from "vitest";

import { documentTextPart, guestTextPart, typedTextOf } from "./attached-text";

describe(typedTextOf, () => {
    it("keeps only what the person typed: no attached document, page capture or guest note", () => {
        expect.assertions(1);

        const message = {
            content: [
                documentTextPart("cv.pdf", "Senior nurse at the city hospital"),
                { providerOptions: { neore: { pageContext: true } }, text: "A captured page", type: "text" },
                guestTextPart("A guest's words", "note-1"),
                { text: "Summarise my CV", type: "text" },
            ],
            role: "user",
        };

        expect(typedTextOf(message)).toBe("Summarise my CV");
    });

    it("keeps the words typed before an attachment in the same string", () => {
        expect.assertions(1);

        expect(typedTextOf({ content: "Summarise this for me\n[Attached Document]\n\nlong extracted text", role: "user" })).toBe("Summarise this for me");
    });

    it("reads a plain string prompt, and nothing from other roles", () => {
        expect.assertions(2);

        expect(typedTextOf({ content: "I am a nurse", role: "user" })).toBe("I am a nurse");
        expect(typedTextOf({ content: "I am a nurse", role: "assistant" })).toBe("");
    });

    it("leaves out a quoted block, so words quoted from a reply are not the person's own", () => {
        expect.assertions(2);

        expect(typedTextOf({ content: "> The assistant said this\n>\n> and more\n\nI agree with that", role: "user" })).toBe("I agree with that");
        expect(typedTextOf({ content: [{ text: "> quoted reply\n\nmy own sentence", type: "text" }], role: "user" })).toBe("my own sentence");
    });
});

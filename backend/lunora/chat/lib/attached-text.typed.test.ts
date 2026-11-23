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

    it("keeps a messenger caption and drops the attachment lines messenger writes after it in the same part", () => {
        expect.assertions(4);

        // As `messenger/functions.ts` saves a received message: the caption and the attachment lines joined in one part.
        const received = (text: string) => typedTextOf({ content: [{ text, type: "text" }], role: "user" });

        expect(received("fix the roof\n\n[Attached file: photo.jpg (image/jpeg) — its contents cannot be read here]")).toBe("fix the roof");
        expect(received("read this\n\n[Document: plan.pdf]\nquarterly numbers")).toBe("read this");
        expect(received('[Voice message transcript]\ncall the plumber\n\n[Attachment "a.zip" not read: this type of file is not supported]')).toBe("");
        expect(received("[Voice message: it could not be transcribed]")).toBe("");
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

import { describe, expect, it } from "vitest";

import { documentTextPart, guestTextPart, messengerTextPart, typedTextOf } from "./attached-text";

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
        expect.assertions(5);

        // As `messenger/functions.ts` saves a received message: the caption and the attachment lines joined in one marked part.
        const received = (text: string) => typedTextOf({ content: [messengerTextPart(text)], role: "user" });

        expect(received("fix the roof\n\n[Attached file: photo.jpg (image/jpeg) — its contents cannot be read here]")).toBe("fix the roof");
        expect(received("read this\n\n[Document: plan.pdf]\nquarterly numbers")).toBe("read this");
        expect(received('[Voice message transcript]\ncall the plumber\n\n[Attachment "a.zip" not read: this type of file is not supported]')).toBe("");
        // The name is written as sent, quotes included (`messenger/media.ts#skippedLine` strips only control characters).
        expect(received('see this\n[Attachment "a"b.zip" not read: this type of file is not supported]')).toBe("see this");
        expect(received("[Voice message: it could not be transcribed]")).toBe("");
    });

    it("keeps a typed line that looks like messenger's attachment line in a prompt messenger did not write", () => {
        expect.assertions(2);

        const typed = 'what does this mean\n[Attached file: x]\n[Voice message: hi]\n[Attachment "a" not read: why]\nand the rest I typed';

        expect(typedTextOf({ content: [{ text: typed, type: "text" }], role: "user" })).toBe(typed);
        expect(typedTextOf({ content: typed, role: "user" })).toBe(typed);
    });

    it("drops messenger's attachment lines from an unmarked row it is told came through messenger", () => {
        expect.assertions(2);

        const saved = "fix the roof\n\n[Attached file: photo.jpg (image/jpeg) — its contents cannot be read here]";

        expect(typedTextOf({ content: [{ text: saved, type: "text" }], role: "user" }, { messengerOrigin: true })).toBe("fix the roof");
        expect(typedTextOf({ content: saved, role: "user" }, { messengerOrigin: true })).toBe("fix the roof");
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

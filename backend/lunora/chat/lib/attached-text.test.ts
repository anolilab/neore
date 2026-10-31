import { describe, expect, it } from "vitest";

import { documentTextPart, isAttachedContentText, messagesCarryAttachedText } from "./attached-text";
import { formatPageContextPart } from "./page-context";

describe("documentTextPart", () => {
    it("opens with a label naming the file, then the extracted text", () => {
        expect(documentTextPart("report.pdf", "body")).toMatchObject({ text: "[Document: report.pdf]\n\nbody", type: "text" });
        expect(documentTextPart(undefined, "body")).toMatchObject({ text: "[Attached Document]\n\nbody", type: "text" });
    });
});

describe("isAttachedContentText", () => {
    it("recognises every shape the chat start puts attached content in", () => {
        expect(isAttachedContentText(documentTextPart("a.pdf", "x").text)).toBe(true);
        expect(isAttachedContentText(documentTextPart(undefined, "x").text)).toBe(true);
        expect(isAttachedContentText(formatPageContextPart({ text: "x", title: "t", url: "https://example.com" }).text)).toBe(true);
        expect(isAttachedContentText("typed\n\n[Document: a.txt]\nbody")).toBe(true);
    });

    it("does not flag ordinary typed text", () => {
        expect(isAttachedContentText("summarise the Document class")).toBe(false);
        expect(isAttachedContentText("")).toBe(false);
    });
});

describe("messagesCarryAttachedText", () => {
    it("reads user text parts and strings, and ignores other roles", () => {
        expect(messagesCarryAttachedText([{ content: [documentTextPart("a.pdf", "x")], role: "user" }])).toBe(true);
        expect(messagesCarryAttachedText([{ content: "[Document: a.txt]\nx", role: "user" }])).toBe(true);
        expect(messagesCarryAttachedText([{ content: [{ text: "hi", type: "text" }], role: "user" }])).toBe(false);
        expect(messagesCarryAttachedText([{ content: [{ text: "hello", type: "text" }], role: "assistant" }])).toBe(false);
    });

    it("trusts the structural page marker even when the label text was changed", () => {
        const part = { providerOptions: { neore: { pageContext: { kind: "page" } } }, text: "renamed", type: "text" };

        expect(messagesCarryAttachedText([{ content: [part], role: "user" }])).toBe(true);
    });
});

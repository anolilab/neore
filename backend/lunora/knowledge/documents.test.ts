import { describe, expect, it } from "vitest";

import { chunkText } from "./chunking";
import {
    decodedDocumentBytes,
    isAcceptedDocumentType,
    MAX_BATCH_CHARS,
    MAX_DOCUMENT_BYTES,
    MAX_DOCUMENT_CONTENT_CHARS,
    MAX_DOCUMENTS_PER_BATCH,
    normalizeRelativePath,
    validateDocumentBatch,
} from "./documents-shared";

const doc = (extra: Partial<Parameters<typeof validateDocumentBatch>[0][number]> = {}) => {
    return { content: "hello", encoding: "utf8" as const, mimeType: "text/markdown", name: "a.md", ...extra };
};

describe(validateDocumentBatch, () => {
    it("accepts a batch of text and base64 documents", () => {
        expect(() => validateDocumentBatch([doc(), doc({ content: "aGk=", encoding: "base64", mimeType: "application/pdf", name: "b.pdf" })])).not.toThrow();
    });

    it("refuses an empty batch, too many documents, and unsupported types", () => {
        expect(() => validateDocumentBatch([])).toThrow();
        expect(() => validateDocumentBatch(Array.from({ length: MAX_DOCUMENTS_PER_BATCH + 1 }, () => doc()))).toThrow();
        expect(() => validateDocumentBatch([doc({ mimeType: "image/png" })])).toThrow("not supported");
        expect(() => validateDocumentBatch([doc({ content: "" })])).toThrow("empty");
        expect(() => validateDocumentBatch([doc({ name: " " })])).toThrow();
    });

    it("caps each document decoded, and the batch as sent", () => {
        expect(() => validateDocumentBatch([doc({ content: "x".repeat(MAX_DOCUMENT_BYTES + 1) })])).toThrow("larger");

        const nearCap = "A".repeat(Math.floor(((MAX_DOCUMENT_BYTES - 16) * 4) / 3 / 4) * 4);

        expect(() => validateDocumentBatch([doc({ content: nearCap, encoding: "base64", mimeType: "application/pdf" })])).not.toThrow();
        expect(() =>
            validateDocumentBatch(
                Array.from({ length: Math.ceil(MAX_BATCH_CHARS / nearCap.length) + 1 }, () =>
                    doc({ content: nearCap, encoding: "base64", mimeType: "application/pdf" }),
                ),
            ),
        ).toThrow("too large");
    });
});

describe("MAX_DOCUMENT_CONTENT_CHARS", () => {
    it("admits a full-size base64 document, so the per-file check names it instead of the validator failing the batch", () => {
        // The shortest base64 whose decoded size passes the cap.
        const justOver = "A".repeat(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4);

        expect(decodedDocumentBytes({ content: justOver, encoding: "base64" })).toBeGreaterThan(MAX_DOCUMENT_BYTES);
        expect(justOver.length).toBeLessThanOrEqual(MAX_DOCUMENT_CONTENT_CHARS);
        expect(() => validateDocumentBatch([doc({ content: justOver, encoding: "base64", mimeType: "application/pdf", name: "big.pdf" })])).toThrow(
            "big.pdf is larger",
        );
    });
});

describe(normalizeRelativePath, () => {
    it("keeps a folder path and drops anything that walks out of it", () => {
        expect(normalizeRelativePath(String.raw`handbook\policies/./leave.md`)).toBe("handbook/policies/leave.md");
        expect(normalizeRelativePath("../../etc/passwd")).toBe("etc/passwd");
        expect(normalizeRelativePath("")).toBeUndefined();
        expect(normalizeRelativePath("/")).toBeUndefined();
    });
});

describe(decodedDocumentBytes, () => {
    it("measures base64 decoded and text as UTF-8", () => {
        expect(decodedDocumentBytes({ content: "aGVsbG8=", encoding: "base64" })).toBe(5);
        expect(decodedDocumentBytes({ content: "ä", encoding: "utf8" })).toBe(2);
    });
});

describe(isAcceptedDocumentType, () => {
    it("accepts text and parser formats, with parameters", () => {
        expect(isAcceptedDocumentType("text/html; charset=utf-8")).toBe(true);
        expect(isAcceptedDocumentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
        expect(isAcceptedDocumentType("application/zip")).toBe(false);
    });
});

describe(chunkText, () => {
    it("keeps chunk indexes contiguous — a citation's passage number is index + 1", () => {
        const text = Array.from({ length: 40 }, (_, index) => `Paragraph ${String(index)} ${"word ".repeat(60)}`).join("\n\n");

        expect(chunkText(text).map((chunk) => chunk.index)).toEqual(chunkText(text).map((_, index) => index));
    });
});

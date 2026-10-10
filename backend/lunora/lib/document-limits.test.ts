import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    chatAttachmentLimit,
    exceedsDocumentLimit,
    isDocumentMimeType,
    MAX_EXTRACTION_DOCUMENT_BYTES,
    MAX_EXTRACTION_DOCUMENT_MEGABYTES,
} from "./document-limits";

describe("document limits", () => {
    it("caps documents at 25 MiB", () => {
        expect(MAX_EXTRACTION_DOCUMENT_BYTES).toBe(25 * 1024 * 1024);
        expect(MAX_EXTRACTION_DOCUMENT_MEGABYTES).toBe(25);
        expect(exceedsDocumentLimit(MAX_EXTRACTION_DOCUMENT_BYTES)).toBe(false);
        expect(exceedsDocumentLimit(MAX_EXTRACTION_DOCUMENT_BYTES + 1)).toBe(true);
    });

    it("matches the parser's own cap", () => {
        // The Worker's 413 must agree with what the backend and the UI let through.
        const shape = readFileSync(join(import.meta.dirname, "../../../services/document-parser/src/shape.rs"), "utf8");

        expect(shape).toContain("pub const MAX_DOCUMENT_BYTES: usize = 25 * 1024 * 1024;");
    });

    it.each([
        ["application/pdf", true],
        ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", true],
        ["text/plain", true],
        ["application/octet-stream", true],
        ["image/png", false],
        ["audio/mpeg", false],
        ["Video/MP4", false],
    ])("%s is a document: %s", (mimeType, expected) => {
        expect(isDocumentMimeType(mimeType)).toBe(expected);
    });
});

describe("chat attachment limits", () => {
    it.each([
        ["application/pdf", true, 25 * 1024 * 1024],
        ["text/markdown", true, 25 * 1024 * 1024],
        ["image/png", false, 20 * 1024 * 1024],
        ["audio/mpeg", false, 20 * 1024 * 1024],
        ["video/mp4", false, 100 * 1024 * 1024],
        [" Video/MP4 ", false, 100 * 1024 * 1024],
    ])("%s: document %s, at most %d bytes", (mimeType, isDocument, maxBytes) => {
        expect(chatAttachmentLimit(mimeType)).toStrictEqual({ isDocument, maxBytes });
    });

    it("gives documents exactly the extraction cap", () => {
        expect(chatAttachmentLimit("application/pdf").maxBytes).toBe(MAX_EXTRACTION_DOCUMENT_BYTES);
    });
});

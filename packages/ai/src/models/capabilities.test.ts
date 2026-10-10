import { describe, expect, it } from "vitest";

import { DEFAULT_FILE_PART_MIME_TYPES, INGEST_SUPPORTED_MIME, isFilePartSupported, isIngestSupported } from "./capabilities";

describe("isFilePartSupported", () => {
    it("should return true for supported MIME types", () => {
        expect(isFilePartSupported("image/jpeg")).toBe(true);
        expect(isFilePartSupported("image/png")).toBe(true);
        expect(isFilePartSupported("image/webp")).toBe(true);
        expect(isFilePartSupported("image/gif")).toBe(true);
        expect(isFilePartSupported("application/pdf")).toBe(true);
    });

    it("should return false for unsupported MIME types", () => {
        expect(isFilePartSupported("text/plain")).toBe(false);
        expect(isFilePartSupported("application/json")).toBe(false);
        expect(isFilePartSupported("video/mp4")).toBe(false);
        expect(isFilePartSupported("audio/mp3")).toBe(false);
    });

    it("should return false for undefined/empty MIME type", () => {
        expect(isFilePartSupported(undefined)).toBe(false);
        expect(isFilePartSupported("")).toBe(false);
    });

    it("should support custom MIME type arrays", () => {
        const customMimes = ["text/plain", "application/json"];

        expect(isFilePartSupported("text/plain", customMimes)).toBe(true);
        expect(isFilePartSupported("image/jpeg", customMimes)).toBe(false);
    });
});

describe("isIngestSupported", () => {
    it("should return true for CSV MIME types", () => {
        expect(isIngestSupported("text/csv")).toBe(true);
        expect(isIngestSupported("application/csv")).toBe(true);
    });

    it("should return false for non-CSV MIME types", () => {
        expect(isIngestSupported("image/png")).toBe(false);
        expect(isIngestSupported("application/json")).toBe(false);
        expect(isIngestSupported("text/plain")).toBe(false);
    });

    it("should return false for undefined/empty MIME type", () => {
        expect(isIngestSupported(undefined)).toBe(false);
        expect(isIngestSupported("")).toBe(false);
    });
});

describe("DEFAULT_FILE_PART_MIME_TYPES", () => {
    it("should contain expected MIME types", () => {
        expect(DEFAULT_FILE_PART_MIME_TYPES).toContain("image/jpeg");
        expect(DEFAULT_FILE_PART_MIME_TYPES).toContain("image/png");
        expect(DEFAULT_FILE_PART_MIME_TYPES).toContain("image/webp");
        expect(DEFAULT_FILE_PART_MIME_TYPES).toContain("image/gif");
        expect(DEFAULT_FILE_PART_MIME_TYPES).toContain("application/pdf");
    });
});

describe("INGEST_SUPPORTED_MIME", () => {
    it("should contain CSV MIME types", () => {
        expect(INGEST_SUPPORTED_MIME.has("text/csv")).toBe(true);
        expect(INGEST_SUPPORTED_MIME.has("application/csv")).toBe(true);
    });
});

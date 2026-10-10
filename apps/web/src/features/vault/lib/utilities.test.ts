import { describe, expect, it } from "vitest";

import { formatFileSize, getFileIcon } from "./utilities";

describe("formatFileSize", () => {
    it("should format 0 bytes", () => {
        expect(formatFileSize(0)).toBe("0 Bytes");
    });

    it("should format bytes", () => {
        expect(formatFileSize(500)).toBe("500 Bytes");
    });

    it("should format kilobytes", () => {
        expect(formatFileSize(1024)).toBe("1 KB");
        expect(formatFileSize(1536)).toBe("1.5 KB");
    });

    it("should format megabytes", () => {
        expect(formatFileSize(1_048_576)).toBe("1 MB");
        expect(formatFileSize(5_242_880)).toBe("5 MB");
    });

    it("should format gigabytes", () => {
        expect(formatFileSize(1_073_741_824)).toBe("1 GB");
    });

    it("should format terabytes", () => {
        expect(formatFileSize(1_099_511_627_776)).toBe("1 TB");
    });

    it("should format with decimal precision", () => {
        expect(formatFileSize(1_500_000)).toBe("1.43 MB");
    });
});

describe("getFileIcon", () => {
    it("should return image icon for image types", () => {
        expect(getFileIcon("image/png")).toBe("🖼️");
        expect(getFileIcon("image/jpeg")).toBe("🖼️");
        expect(getFileIcon("image/webp")).toBe("🖼️");
    });

    it("should return video icon for video types", () => {
        expect(getFileIcon("video/mp4")).toBe("🎥");
        expect(getFileIcon("video/webm")).toBe("🎥");
    });

    it("should return audio icon for audio types", () => {
        expect(getFileIcon("audio/mp3")).toBe("🎵");
        expect(getFileIcon("audio/wav")).toBe("🎵");
    });

    it("should return PDF icon for PDFs", () => {
        expect(getFileIcon("application/pdf")).toBe("📄");
    });

    it("should return document icon for word documents", () => {
        expect(getFileIcon("application/msword")).toBe("📝");
        expect(getFileIcon("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("📝");
    });

    it("should return spreadsheet icon for old-style Excel MIME", () => {
        expect(getFileIcon("application/vnd.ms-excel")).toBe("📊");
    });

    it("should return presentation icon for old-style PowerPoint MIME", () => {
        expect(getFileIcon("application/vnd.ms-powerpoint")).toBe("📽️");
    });

    it("should match document check first for openxml MIME types", () => {
        // openxml MIME types contain "officedocument" so they match "document" check first
        expect(getFileIcon("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("📝");
        expect(getFileIcon("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("📝");
    });

    it("should return default icon for unknown types", () => {
        expect(getFileIcon("application/octet-stream")).toBe("📄");
        expect(getFileIcon("text/plain")).toBe("📄");
    });
});

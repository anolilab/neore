import { describe, expect, it } from "vitest";

import sanitizeAndValidateFileName from "./filename";

describe("sanitizeAndValidateFileName", () => {
    describe("basic sanitization", () => {
        it("should preserve valid filenames", () => {
            expect(sanitizeAndValidateFileName("document.pdf")).toBe("document.pdf");
            expect(sanitizeAndValidateFileName("my-file.txt")).toBe("my-file.txt");
            expect(sanitizeAndValidateFileName("photo_001.jpg")).toBe("photo_001.jpg");
        });

        it("should trim whitespace", () => {
            expect(sanitizeAndValidateFileName("  file.txt  ")).toBe("file.txt");
        });

        it("should replace invalid punctuation with underscores", () => {
            expect(sanitizeAndValidateFileName("file<name>.txt")).toBe("file_name_.txt");
            expect(sanitizeAndValidateFileName(String.raw`path/to\file.txt`)).toBe("path_to_file.txt");
            expect(sanitizeAndValidateFileName('file:"name"?.txt')).toBe("file__name__.txt");
            expect(sanitizeAndValidateFileName("file|name*.txt")).toBe("file_name_.txt");
        });

        it("should collapse multiple whitespace to single space", () => {
            expect(sanitizeAndValidateFileName("my   file   name.txt")).toBe("my file name.txt");
        });

        it("should strip control characters", () => {
            expect(sanitizeAndValidateFileName("file\u{0}name.txt")).toBe("filename.txt");
            expect(sanitizeAndValidateFileName("file\u{1F}name.txt")).toBe("filename.txt");
            expect(sanitizeAndValidateFileName("file\u{7F}name.txt")).toBe("filename.txt");
        });
    });

    describe("empty/dot-only inputs", () => {
        it("should default to 'file' for empty input", () => {
            expect(sanitizeAndValidateFileName("")).toBe("file");
        });

        it("should default to 'file' for dot-only names", () => {
            expect(sanitizeAndValidateFileName(".")).toBe("file");
            expect(sanitizeAndValidateFileName("...")).toBe("file");
        });

        it("should default to 'file' for whitespace-only input", () => {
            expect(sanitizeAndValidateFileName(" ".repeat(3))).toBe("file");
        });
    });

    describe("Windows reserved names", () => {
        it("should append '-file' to reserved basenames", () => {
            expect(sanitizeAndValidateFileName("CON")).toBe("CON-file");
            expect(sanitizeAndValidateFileName("con")).toBe("con-file");
            expect(sanitizeAndValidateFileName("PRN")).toBe("PRN-file");
            expect(sanitizeAndValidateFileName("NUL")).toBe("NUL-file");
            expect(sanitizeAndValidateFileName("AUX")).toBe("AUX-file");
        });

        it("should handle reserved names with extensions", () => {
            expect(sanitizeAndValidateFileName("CON.txt")).toBe("CON-file.txt");
            expect(sanitizeAndValidateFileName("lpt1.pdf")).toBe("lpt1-file.pdf");
        });

        it("should handle COM and LPT ports", () => {
            for (let i = 1; i <= 9; i += 1) {
                expect(sanitizeAndValidateFileName(`COM${i}`)).toBe(`COM${i}-file`);
                expect(sanitizeAndValidateFileName(`LPT${i}`)).toBe(`LPT${i}-file`);
            }
        });
    });

    describe("extension handling", () => {
        it("should preserve extensions", () => {
            expect(sanitizeAndValidateFileName("photo.jpg")).toBe("photo.jpg");
            expect(sanitizeAndValidateFileName("archive.tar.gz")).toBe("archive.tar.gz");
        });

        it("should handle filenames without extensions", () => {
            expect(sanitizeAndValidateFileName("README")).toBe("README");
            expect(sanitizeAndValidateFileName("Makefile")).toBe("Makefile");
        });

        it("should handle hidden files (dot prefix)", () => {
            // Dot as first char: lastDot > 0 is false, so treated as no extension
            expect(sanitizeAndValidateFileName(".gitignore")).toBe(".gitignore");
        });
    });

    describe("trailing dots/spaces", () => {
        it("should strip trailing dots from base", () => {
            expect(sanitizeAndValidateFileName("file...")).toBe("file");
        });

        it("should strip trailing spaces from base", () => {
            expect(sanitizeAndValidateFileName("file   .txt")).toBe("file.txt");
        });
    });

    describe("max length enforcement", () => {
        it("should truncate very long filenames", () => {
            const longName = `${"a".repeat(300)}.txt`;
            const result = sanitizeAndValidateFileName(longName);

            expect(result.length).toBeLessThanOrEqual(200);
            expect(result.endsWith(".txt")).toBe(true);
        });

        it("should preserve extension during truncation", () => {
            const longName = `${"x".repeat(250)}.pdf`;
            const result = sanitizeAndValidateFileName(longName);

            expect(result.endsWith(".pdf")).toBe(true);
            expect(result.length).toBeLessThanOrEqual(200);
        });
    });

    describe("unicode", () => {
        it("should handle unicode filenames", () => {
            expect(sanitizeAndValidateFileName("日本語.txt")).toBe("日本語.txt");
            expect(sanitizeAndValidateFileName("café.doc")).toBe("café.doc");
        });

        it("should normalize unicode (NFKC)", () => {
            // ﬁ (U+FB01) normalizes to "fi" in NFKC
            expect(sanitizeAndValidateFileName("ﬁle.txt")).toBe("file.txt");
        });
    });
});

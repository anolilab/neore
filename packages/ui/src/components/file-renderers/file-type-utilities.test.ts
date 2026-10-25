import { describe, expect, it } from "vitest";

import { getFileRendererType, isDelimitedTable, isJsonl, isMermaid, TEXT_PREVIEW_EXTENSIONS } from "./file-type-utilities";

describe("text previews are recognised by file name", () => {
    it.each(["rows.jsonl", "ROWS.JSONL", "events.ndjson"])("%s is JSON Lines", (filename) => {
        expect(isJsonl(filename)).toBe(true);
    });

    it.each(["flow.mmd", "flow.mermaid"])("%s is Mermaid", (filename) => {
        expect(isMermaid(filename)).toBe(true);
    });

    it.each(["data.csv", "data.tsv"])("%s is a delimited table", (filename) => {
        expect(isDelimitedTable(filename)).toBe(true);
    });

    it("does not claim plain JSON, text or a missing name", () => {
        expect(isJsonl("data.json")).toBe(false);
        expect(isMermaid("notes.txt")).toBe(false);
        expect(isDelimitedTable("notes.md")).toBe(false);
        expect(isJsonl(undefined)).toBe(false);
    });
});

describe(getFileRendererType, () => {
    it.each([
        ["text/plain", "rows.jsonl", "jsonl"],
        ["text/plain", "flow.mmd", "mermaid"],
        ["text/plain", "data.csv", "table"],
        ["text/csv", "data.tsv", "table"],
        ["application/octet-stream", "rows.ndjson", "jsonl"],
        [undefined, "data.csv", "table"],
        ["application/pdf", "report.pdf", "pdf"],
        ["video/mp4", "clip.bin", "video"],
        ["audio/mpeg", "song.bin", "audio"],
        ["image/png", "photo.png", "image"],
        ["text/plain", "notes.txt", "generic"],
        [undefined, undefined, "generic"],
    ])("%s / %s is %s", (mediaType, filename, expected) => {
        expect(getFileRendererType(mediaType, filename)).toBe(expected);
    });

    it.each(["application/zip", "application/x-msdownload", "image/png", "application/pdf"])("does not parse a %s file named data.csv as text", (mediaType) => {
        expect(getFileRendererType(mediaType, "data.csv")).not.toBe("table");
    });

    it("lets an image type win over a misleading name", () => {
        expect(getFileRendererType("image/png", "scan.pdf")).toBe("image");
    });
});

describe("TEXT_PREVIEW_EXTENSIONS", () => {
    it("is what each predicate recognises", () => {
        for (const extension of TEXT_PREVIEW_EXTENSIONS.jsonl) {
            expect(isJsonl(`a.${extension}`)).toBe(true);
        }

        for (const extension of TEXT_PREVIEW_EXTENSIONS.mermaid) {
            expect(isMermaid(`a.${extension}`)).toBe(true);
        }

        for (const extension of TEXT_PREVIEW_EXTENSIONS.table) {
            expect(isDelimitedTable(`a.${extension}`)).toBe(true);
        }
    });
});

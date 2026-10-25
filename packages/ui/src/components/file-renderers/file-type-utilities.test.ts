import { describe, expect, it } from "vitest";

import { isDelimitedTable, isJsonl, isMermaid } from "./file-type-utilities";

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

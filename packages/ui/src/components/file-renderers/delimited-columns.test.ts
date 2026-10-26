import Papa from "papaparse";
import { describe, expect, it } from "vitest";

import { capDelimitedColumns, delimiterForFilename, exceedsRowLimit } from "./delimited-columns";

const wideRow = (columns: number, delimiter = ","): string => Array.from({ length: columns }, (_, index) => `c${index}`).join(delimiter);

describe(capDelimitedColumns, () => {
    it("returns a table within the cap untouched", () => {
        const content = "a,b,c\n1,2,3\n";

        expect(capDelimitedColumns(content, 3)).toStrictEqual({ content, delimiter: ",", hiddenColumns: 0 });
    });

    it("keeps the first columns of every row of a wider table and counts the rest", () => {
        const content = `${wideRow(8)}\n${wideRow(8).replaceAll("c", "v")}\n`;
        const result = capDelimitedColumns(content, 3);

        expect(result.hiddenColumns).toBe(5);
        expect(Papa.parse(result.content).data).toStrictEqual([
            ["c0", "c1", "c2"],
            ["v0", "v1", "v2"],
        ]);
    });

    it("keeps a tab-separated table tab-separated", () => {
        const result = capDelimitedColumns(`${wideRow(5, "\t")}\n`, 2);

        expect(result.content.startsWith("c0\tc1")).toBe(true);
        expect(result.content).not.toContain(",");
    });

    it("keeps a quoted field that contains the delimiter in one piece", () => {
        const result = capDelimitedColumns('a,b,c,d\n"x,y",2,3,4\n', 2);

        expect(Papa.parse(result.content).data).toStrictEqual([
            ["a", "b"],
            ["x,y", "2"],
        ]);
    });

    it("measures the header as the first row with content, as the table does", () => {
        const result = capDelimitedColumns(`\n\n${wideRow(200)}\n`, 50);

        expect(result.hiddenColumns).toBe(150);
        expect(Papa.parse(result.content).data[0] as string[]).toHaveLength(50);
    });

    it("caps a later row that is wider than a narrow header", () => {
        const result = capDelimitedColumns(`a,b\n${wideRow(60)}\n1,2\n`, 50);

        expect(result.hiddenColumns).toBe(10);

        const rows = Papa.parse<string[]>(result.content).data;

        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.length <= 50)).toBe(true);
        expect(rows[1]?.at(-1)).toBe("c49");
    });

    it("bounds a table with 200,000 columns to the cap", () => {
        const result = capDelimitedColumns(`${wideRow(200_000)}\n${wideRow(200_000)}\n`, 50);

        expect(result.hiddenColumns).toBe(199_950);
        expect(Papa.parse(result.content).data[0] as string[]).toHaveLength(50);
    });

    it("handles empty content", () => {
        expect(capDelimitedColumns("", 50)).toStrictEqual({ content: "", delimiter: ",", hiddenColumns: 0 });
    });
});

describe("a tab-separated table with commas in its fields", () => {
    const tsv = 'name\tcity\textra\n"Doe, Jane"\tOslo, Norway\tx\nSmith, Bob\tRome, Italy\ty\n';

    it("keeps the right fields when the tab delimiter is given", () => {
        const result = capDelimitedColumns(tsv, 2, "\t");

        expect(result.hiddenColumns).toBe(1);
        expect(Papa.parse(result.content, { delimiter: "\t" }).data).toStrictEqual([
            ["name", "city"],
            ["Doe, Jane", "Oslo, Norway"],
            ["Smith, Bob", "Rome, Italy"],
        ]);
    });

    it("picks the tab delimiter for a .tsv name and detects it for any other", () => {
        expect(delimiterForFilename("data.TSV")).toBe("\t");
        expect(delimiterForFilename("data.csv")).toBeUndefined();
        expect(delimiterForFilename()).toBeUndefined();
    });
});

describe("the delimiter a capped table is in", () => {
    it("reports the detected delimiter, so the renderer is given the same one", () => {
        expect(capDelimitedColumns("a;b;c\n1;2;3", 2).delimiter).toBe(";");
    });
});

describe(exceedsRowLimit, () => {
    it("is false for a file within the row limit, true one row past it", () => {
        expect(exceedsRowLimit("a\nb\nc", 3)).toBe(false);
        expect(exceedsRowLimit("a\nb\nc\nd", 3)).toBe(true);
    });

    it("refuses a file of very many short rows without splitting it", () => {
        expect(exceedsRowLimit("a\n".repeat(100_000), 20_000)).toBe(true);
    });
});

describe("line breaks a row limit counts", () => {
    it("counts a lone CR as a line break, so a CR-only table of too many rows is refused", () => {
        expect(exceedsRowLimit("a\r".repeat(20_001), 20_000)).toBe(true);
    });

    it("counts a CRLF pair once, the same as LF", () => {
        expect(exceedsRowLimit("a\r\nb\r\n", 3)).toBe(exceedsRowLimit("a\nb\n", 3));
        expect(exceedsRowLimit("a\r\nb\r\n", 2)).toBe(true);
        expect(exceedsRowLimit("a\r\nb\r\n", 3)).toBe(false);
    });
});

import Papa from "papaparse";
import { describe, expect, it } from "vitest";

import { capDelimitedColumns } from "./delimited-columns";

const wideRow = (columns: number, delimiter = ","): string => Array.from({ length: columns }, (_, index) => `c${index}`).join(delimiter);

describe(capDelimitedColumns, () => {
    it("returns a table within the cap untouched", () => {
        const content = "a,b,c\n1,2,3\n";

        expect(capDelimitedColumns(content, 3)).toStrictEqual({ content, hiddenColumns: 0 });
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

    it("bounds a table with 200,000 columns to the cap", () => {
        const result = capDelimitedColumns(`${wideRow(200_000)}\n${wideRow(200_000)}\n`, 50);

        expect(result.hiddenColumns).toBe(199_950);
        expect(Papa.parse(result.content).data[0] as string[]).toHaveLength(50);
    });

    it("handles empty content", () => {
        expect(capDelimitedColumns("", 50)).toStrictEqual({ content: "", hiddenColumns: 0 });
    });
});

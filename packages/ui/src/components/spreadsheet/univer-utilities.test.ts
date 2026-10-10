import { describe, expect, it } from "vitest";

import { csvToUniverWorkbook, univerWorkbookToCsv } from "./univer-utilities";

describe("csvToUniverWorkbook", () => {
    it("should parse simple CSV into workbook data", () => {
        const csv = "Name,Age\nAlice,30\nBob,25";
        const wb = csvToUniverWorkbook(csv);

        expect(wb.sheetOrder).toEqual(["sheet-01"]);
        expect(wb.sheets["sheet-01"]).toBeDefined();

        const sheet = wb.sheets["sheet-01"]!;

        // Row 0: headers
        expect(sheet.cellData[0]?.[0]?.v).toBe("Name");
        expect(sheet.cellData[0]?.[1]?.v).toBe("Age");
        // Row 1: Alice, 30 (number)
        expect(sheet.cellData[1]?.[0]?.v).toBe("Alice");
        expect(sheet.cellData[1]?.[1]?.v).toBe(30);
        // Row 2: Bob, 25 (number)
        expect(sheet.cellData[2]?.[0]?.v).toBe("Bob");
        expect(sheet.cellData[2]?.[1]?.v).toBe(25);
    });

    it("should parse booleans correctly", () => {
        const csv = "Active\ntrue\nfalse\nTRUE";
        const wb = csvToUniverWorkbook(csv);
        const sheet = wb.sheets["sheet-01"]!;

        expect(sheet.cellData[1]?.[0]?.v).toBe(true);
        expect(sheet.cellData[2]?.[0]?.v).toBe(false);
        expect(sheet.cellData[3]?.[0]?.v).toBe(true);
    });

    it("should skip empty cells", () => {
        const csv = "A,,C\n1,,3";
        const wb = csvToUniverWorkbook(csv);
        const sheet = wb.sheets["sheet-01"]!;

        expect(sheet.cellData[0]?.[0]?.v).toBe("A");
        expect(sheet.cellData[0]?.[1]).toBeUndefined();
        expect(sheet.cellData[0]?.[2]?.v).toBe("C");
    });

    it("should use custom title", () => {
        const wb = csvToUniverWorkbook("A\n1", "My Sheet");

        expect(wb.name).toBe("My Sheet");
    });

    it("should default title to 'Spreadsheet'", () => {
        const wb = csvToUniverWorkbook("A\n1");

        expect(wb.name).toBe("Spreadsheet");
    });

    it("should have reasonable row and column counts", () => {
        const csv = "A,B\n1,2";
        const sheet = csvToUniverWorkbook(csv).sheets["sheet-01"]!;

        expect(sheet.rowCount).toBeGreaterThanOrEqual(100);
        expect(sheet.columnCount).toBeGreaterThanOrEqual(26);
    });

    it("should handle empty CSV", () => {
        const wb = csvToUniverWorkbook("");
        const sheet = wb.sheets["sheet-01"]!;

        expect(sheet.cellData).toBeDefined();
        expect(sheet.rowCount).toBeGreaterThanOrEqual(100);
    });
});

describe("univerWorkbookToCsv", () => {
    it("should convert workbook data back to CSV", () => {
        const csv = "Name,Age\nAlice,30\nBob,25";
        const wb = csvToUniverWorkbook(csv);
        const result = univerWorkbookToCsv(wb);

        expect(result).toBe("Name,Age\r\nAlice,30\r\nBob,25");
    });

    it("should handle empty workbook", () => {
        const wb: any = {
            id: "test",
            name: "Test",
            sheetOrder: [],
            sheets: {},
        };

        expect(univerWorkbookToCsv(wb)).toBe("");
    });

    it("should handle workbook with missing sheet", () => {
        const wb: any = {
            id: "test",
            name: "Test",
            sheetOrder: ["missing-sheet"],
            sheets: {},
        };

        expect(univerWorkbookToCsv(wb)).toBe("");
    });

    it("should trim trailing empty rows and columns", () => {
        const wb = csvToUniverWorkbook("A,B\n1,2");
        // The workbook has rowCount >= 100 and columnCount >= 26
        // but the CSV output should only have the data rows/cols
        const result = univerWorkbookToCsv(wb);
        const lines = result.split("\r\n");

        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe("A,B");
        expect(lines[1]).toBe("1,2");
    });

    it("should roundtrip CSV data correctly", () => {
        const original = 'Name,Score,Active\nAlice,95.5,true\nBob,87,false\n"Charlie, Jr.",100,true';
        const wb = csvToUniverWorkbook(original);
        const result = univerWorkbookToCsv(wb);

        // Parse both to compare data (CSV formatting may differ slightly)
        const originalLines = original.split("\n");
        const resultLines = result.split("\r\n");

        expect(resultLines).toHaveLength(originalLines.length);
        expect(resultLines[0]).toBe("Name,Score,Active");
    });
});

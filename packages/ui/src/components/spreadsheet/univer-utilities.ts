/**
 * Utility functions for converting between CSV strings and Univer workbook data.
 */

import Papa from "papaparse";

interface UniverCellData {
    [rowIndex: number]: {
        [colIndex: number]: { v: string | number | boolean };
    };
}

interface UniverSheetData {
    cellData: UniverCellData;
    columnCount: number;
    id: string;
    name: string;
    rowCount: number;
}

export interface UniverWorkbookData {
    id: string;
    name: string;
    sheetOrder: string[];
    sheets: Record<string, UniverSheetData>;
}

/**
 * Parse a CSV string into Univer workbook data format.
 */
export const csvToUniverWorkbook = (csv: string, title?: string): UniverWorkbookData => {
    const result = Papa.parse<string[]>(csv, {
        skipEmptyLines: true,
    });

    const rows = result.data;
    const cellData: UniverCellData = {};

    for (const [rowIndex, row] of rows.entries()) {
        if (!row) {
            continue;
        }

        cellData[rowIndex] = {};

        const rowData = cellData[rowIndex]!;

        for (const [colIndex, raw] of row.entries()) {
            if (raw == null || raw === "") {
                continue;
            }

            // Try to parse as number
            const numericValue = Number(raw);

            if (!Number.isNaN(numericValue) && raw.trim() !== "") {
                rowData[colIndex] = { v: numericValue };
            } else if (raw.toLowerCase() === "true" || raw.toLowerCase() === "false") {
                rowData[colIndex] = { v: raw.toLowerCase() === "true" };
            } else {
                rowData[colIndex] = { v: raw };
            }
        }
    }

    const rowCount = Math.max(rows.length + 20, 100);
    const columnCount = Math.max(Math.max(...rows.map((r) => r.length), 0) + 5, 26);

    return {
        id: `workbook-${Date.now()}`,
        name: title ?? "Spreadsheet",
        sheetOrder: ["sheet-01"],
        sheets: {
            "sheet-01": {
                cellData,
                columnCount,
                id: "sheet-01",
                name: "Sheet 1",
                rowCount,
            },
        },
    };
};

/**
 * Convert Univer workbook snapshot data back to a CSV string.
 */
export const univerWorkbookToCsv = (snapshot: UniverWorkbookData): string => {
    const sheetId = snapshot.sheetOrder[0];

    if (!sheetId) {
        return "";
    }

    const sheet = snapshot.sheets[sheetId];

    if (!sheet) {
        return "";
    }

    const { cellData, columnCount, rowCount } = sheet;

    // Find the actual data bounds (skip trailing empty rows/cols)
    let maxRow = 0;
    let maxCol = 0;

    for (let r = 0; r < rowCount; r++) {
        const row = cellData[r];

        if (!row) {
            continue;
        }

        for (let c = 0; c < columnCount; c++) {
            const cell = row[c];

            if (cell?.v != null && String(cell.v) !== "") {
                maxRow = Math.max(maxRow, r);
                maxCol = Math.max(maxCol, c);
            }
        }
    }

    const rows: string[][] = [];

    for (let r = 0; r <= maxRow; r++) {
        const row: string[] = [];

        for (let c = 0; c <= maxCol; c++) {
            const cell = cellData[r]?.[c];

            row.push(cell?.v == null ? "" : String(cell.v));
        }

        rows.push(row);
    }

    return Papa.unparse(rows);
};

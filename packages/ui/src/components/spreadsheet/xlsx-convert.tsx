/**
 * XLSX conversion utilities.
 *
 * - `xlsxFileToCSV`  — parse an XLSX/XLS File → CSV string (first sheet).
 * - `downloadAsXlsx` — take a CSV string and trigger an `.xlsx` download.
 *
 * Both functions lazy-import the heavy `xlsx` library so the main bundle
 * stays small.
 */

import Papa from "papaparse";

/**
 * Read the first sheet of an XLSX/XLS file and return it as a CSV string.
 * @returns `{ csv, sheetCount }` — the CSV string for sheet 1 and the total
 * number of sheets (so callers can warn about multi-sheet workbooks).
 */
export const xlsxFileToCSV = async (file: File): Promise<{ csv: string; sheetCount: number }> => {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { cellDates: true, cellText: false, type: "array" });

    const sheetCount = workbook.SheetNames.length;
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
        return { csv: "", sheetCount: 0 };
    }

    const ws = workbook.Sheets[firstSheetName];

    if (!ws) {
        return { csv: "", sheetCount };
    }

    // Convert to array-of-arrays, then use papaparse for consistent CSV output.
    const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { defval: "", header: 1, raw: false });
    const csv = Papa.unparse(rows);

    return { csv, sheetCount };
};

/**
 * Convert a CSV string to an XLSX workbook and trigger a browser download.
 */
export const downloadAsXlsx = async (csv: string, filename: string): Promise<void> => {
    const XLSX = await import("xlsx");
    const result = Papa.parse<string[]>(csv, { skipEmptyLines: true });
    const ws = XLSX.utils.aoa_to_sheet(result.data);
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, ws, "Sheet 1");
    XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
};

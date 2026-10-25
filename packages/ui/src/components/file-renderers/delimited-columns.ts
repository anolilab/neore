import Papa from "papaparse";

/**
 * Keeps a delimited table to its first `maxColumns` columns, so a file with
 * hundreds of thousands of them cannot freeze the page (each column costs a
 * header cell and one cell per row). A table already within the cap is
 * returned untouched.
 */
export interface CappedColumns {
    content: string;
    /** Columns cut off, for the "+N more" note. */
    hiddenColumns: number;
}

export const capDelimitedColumns = (content: string, maxColumns: number): CappedColumns => {
    // Blank lines are skipped, as `CsvRenderer` skips them: its header is the first row with content.
    const parsed = Papa.parse<string[]>(content, { skipEmptyLines: true });
    const width = parsed.data[0]?.length ?? 0;

    if (width <= maxColumns) {
        return { content, hiddenColumns: 0 };
    }

    // The same delimiter is written back, so a TSV stays a TSV.
    return {
        content: Papa.unparse(
            parsed.data.map((row) => row.slice(0, maxColumns)),
            { delimiter: parsed.meta.delimiter },
        ),
        hiddenColumns: width - maxColumns,
    };
};

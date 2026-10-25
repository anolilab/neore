import Papa from "papaparse";

/**
 * Keeps a delimited table to its first `maxColumns` columns, so a file with
 * hundreds of thousands of them cannot freeze the page (each column costs a
 * header cell and one cell per row). A table already within the cap is
 * returned untouched, after reading only its first row.
 */
export interface CappedColumns {
    content: string;
    /** Columns cut off, for the "+N more" note. */
    hiddenColumns: number;
}

export const capDelimitedColumns = (content: string, maxColumns: number): CappedColumns => {
    const firstRow = Papa.parse<string[]>(content, { preview: 1 });
    const width = firstRow.data[0]?.length ?? 0;

    if (width <= maxColumns) {
        return { content, hiddenColumns: 0 };
    }

    // The same delimiter is written back, so a TSV stays a TSV.
    const rows = Papa.parse<string[]>(content, { delimiter: firstRow.meta.delimiter, skipEmptyLines: true }).data;

    return {
        content: Papa.unparse(
            rows.map((row) => row.slice(0, maxColumns)),
            { delimiter: firstRow.meta.delimiter },
        ),
        hiddenColumns: width - maxColumns,
    };
};

import Papa from "papaparse";

/**
 * Keeps a delimited table to its first `maxColumns` columns, so a file with
 * hundreds of thousands of them cannot freeze the page (each column costs a
 * header cell and one cell per row). A table already within the cap is
 * returned untouched. Every row is measured, not only the first: a later row
 * can be wider than the header.
 */
export interface CappedColumns {
    content: string;
    /** Columns cut off, for the "+N more" note. */
    hiddenColumns: number;
}

/**
 * The delimiter a file name fixes, or `undefined` to detect it from the content.
 * A TSV is tab-separated whatever its fields hold: left to detection, a comma
 * inside unquoted fields can outvote the tabs.
 */
export const delimiterForFilename = (filename?: string): string | undefined => (filename?.toLowerCase().endsWith(".tsv") ? "\t" : undefined);

export const capDelimitedColumns = (content: string, maxColumns: number, delimiter?: string): CappedColumns => {
    // Blank lines are skipped, as `CsvRenderer` skips them: its header is the first row with content.
    const parsed = Papa.parse<string[]>(content, { delimiter, skipEmptyLines: true });
    const width = parsed.data.reduce((widest, row) => Math.max(widest, row.length), 0);

    if (width <= maxColumns) {
        return { content, hiddenColumns: 0 };
    }

    // The same delimiter is written back, so a TSV stays a TSV.
    return {
        content: Papa.unparse(
            parsed.data.map((row) => row.slice(0, maxColumns)),
            { delimiter: delimiter ?? parsed.meta.delimiter },
        ),
        hiddenColumns: width - maxColumns,
    };
};

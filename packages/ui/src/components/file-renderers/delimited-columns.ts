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
    /** The delimiter the content is in: the file name's, or the one detected, so the renderer is given the same. */
    delimiter: string;
    /** Columns cut off, for the "+N more" note. */
    hiddenColumns: number;
}

/**
 * The delimiter a file name fixes, or `undefined` to detect it from the content.
 * A TSV is tab-separated whatever its fields hold: left to detection, a comma
 * inside unquoted fields can outvote the tabs.
 */
export const delimiterForFilename = (filename?: string): string | undefined => (filename?.toLowerCase().endsWith(".tsv") ? "\t" : undefined);

/**
 * Whether `content` has more than `maxRows` lines, counted without splitting it. A file of short rows can hold
 * hundreds of thousands of records within the byte limit, and parsing them all is what freezes a page.
 */
export const exceedsRowLimit = (content: string, maxRows: number): boolean => {
    // A record ends at each line break (LF, CRLF or a lone CR, CRLF counting once). A break that ends the file does
    // not start another record, so a file of exactly `maxRows` newline-terminated records is within the limit.
    let breaks = 0;

    for (let index = 0; index < content.length; index += 1) {
        const code = content.codePointAt(index) ?? 0;

        if (code === 10 || (code === 13 && content.codePointAt(index + 1) !== 10)) {
            breaks += 1;

            if (breaks > maxRows) {
                return true;
            }
        }
    }

    const last = content.codePointAt(content.length - 1);
    const endsWithBreak = last === 10 || last === 13;
    const records = breaks + (content.length > 0 && !endsWithBreak ? 1 : 0);

    return records > maxRows;
};

export const capDelimitedColumns = (content: string, maxColumns: number, delimiter?: string): CappedColumns => {
    // Blank lines are skipped, as `CsvRenderer` skips them: its header is the first row with content.
    const parsed = Papa.parse<string[]>(content, { delimiter, skipEmptyLines: true });
    const width = parsed.data.reduce((widest, row) => Math.max(widest, row.length), 0);

    const effective = delimiter ?? parsed.meta.delimiter;

    if (width <= maxColumns) {
        return { content, delimiter: effective, hiddenColumns: 0 };
    }

    // The same delimiter is written back, so a TSV stays a TSV.
    return {
        content: Papa.unparse(
            parsed.data.map((row) => row.slice(0, maxColumns)),
            { delimiter: effective },
        ),
        delimiter: effective,
        hiddenColumns: width - maxColumns,
    };
};

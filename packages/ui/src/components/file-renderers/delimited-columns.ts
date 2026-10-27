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

/** Whether a quote at `index` opens a field: it starts the record or follows the delimiter (Papa's rule). */
const opensField = (content: string, index: number, delimiter: string): boolean =>
    index === 0 || content[index - 1] === delimiter || content[index - 1] === "\n" || content[index - 1] === "\r";

/** The index just past the quote that closes the quoted field opened at `start`, or the end of the content if it never closes. */
const quotedFieldEnd = (content: string, start: number): number => {
    let index = start + 1;

    while (index < content.length) {
        if (content[index] !== '"') {
            index += 1;
        } else if (content[index + 1] === '"') {
            index += 2;
        } else {
            return index + 1;
        }
    }

    return content.length;
};

/** The index of the line break that ends the record starting at `start`, or the content's length if none does. */
const recordEnd = (content: string, start: number, delimiter: string): number => {
    let index = start;

    while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
        index = content[index] === '"' && opensField(content, index, delimiter) ? quotedFieldEnd(content, index) : index + 1;
    }

    return index;
};

/**
 * Whether `content` has more than `maxRows` records, counted without parsing it. A file of short rows can hold
 * hundreds of thousands of them within the byte limit, and parsing them all is what freezes a page.
 *
 * A record ends at a line break outside quotes (LF, CRLF or a lone CR), so a line break inside a quoted field does
 * not count. A line with no text is skipped, as `CsvRenderer` skips it. A break that ends the file does not start
 * another record, so a file of exactly `maxRows` records is within the limit.
 */
export const exceedsRowLimit = (content: string, maxRows: number, delimiter?: string): boolean => {
    // Papa sniffs the delimiter from the first rows when none is given, as `CsvRenderer` does.
    const separator = delimiter ?? Papa.parse(content, { preview: 10 }).meta.delimiter;
    let records = 0;
    let index = 0;

    while (index < content.length) {
        const end = recordEnd(content, index, separator);

        // A line that is only `""` is one empty field, which Papa's skipEmptyLines drops as it drops a blank line.
        if (end > index && content.slice(index, end) !== '""') {
            records += 1;

            if (records > maxRows) {
                return true;
            }
        }

        index = end + (content[end] === "\r" && content[end + 1] === "\n" ? 2 : 1);
    }

    return false;
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

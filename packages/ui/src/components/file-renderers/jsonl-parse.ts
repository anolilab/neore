/**
 * Parses JSON Lines (one JSON value per line) for the preview. Pure, so the
 * viewer and its tests share one reading of the format.
 *
 * Line numbers are physical: blank lines count, so a number matches what an
 * editor shows. Parsing stops once either cap is reached, so a large file costs
 * the cap, not its size; `truncated` says that more content was not read.
 */

export interface JsonlRecord {
    line: number;
    value: unknown;
}

export interface JsonlProblem {
    line: number;
    /** The parser's own message, shown as a technical detail. */
    message: string;
    /** The start of the offending line, so the user can see what is wrong. */
    preview: string;
}

export interface JsonlParseResult {
    problems: JsonlProblem[];
    records: JsonlRecord[];
    truncated: boolean;
}

export interface JsonlParseLimits {
    maxProblems: number;
    maxRecords: number;
}

const PREVIEW_CHARS = 160;
const BYTE_ORDER_MARK = "\u{FEFF}";

export const parseJsonLines = (text: string, limits: JsonlParseLimits): JsonlParseResult => {
    const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
    const records: JsonlRecord[] = [];
    const problems: JsonlProblem[] = [];
    let truncated = false;
    let start = 0;
    let line = 0;

    while (start < source.length) {
        const newline = source.indexOf("\n", start);
        const end = newline === -1 ? source.length : newline;
        // `trim` drops the `\r` of a CRLF line; JSON.parse tolerates the rest of the whitespace.
        const content = source.slice(start, end).trim();

        line += 1;
        start = end + 1;

        // Blank lines never count toward a cap, so trailing ones cannot read as unread content.
        if (content === "") {
            continue;
        }

        if (records.length >= limits.maxRecords || problems.length >= limits.maxProblems) {
            truncated = true;

            break;
        }

        try {
            records.push({ line, value: JSON.parse(content) as unknown });
        } catch (error) {
            problems.push({
                line,
                message: error instanceof Error ? error.message : String(error),
                preview: content.slice(0, PREVIEW_CHARS),
            });
        }
    }

    return { problems, records, truncated };
};

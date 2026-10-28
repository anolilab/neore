/**
 * A unified diff of two texts, and its line counts. Pure: the texts are whatever an agent wrote, so every size here
 * is bounded and nothing is evaluated.
 */

/** Marks a last line that had no newline; the text of a file cannot hold a NUL (`changes.ts` refuses those). */
const NO_EOL = "\u{0}";
const CONTEXT_LINES = 3;
/** The most cells the line-matching table may have (4 bytes each). Past it, the changed middle is shown as removed, then added. */
const MAX_TABLE_CELLS = 4_000_000;

interface Op {
    kind: " " | "+" | "-";
    line: string;
}

export interface FileDiff {
    added: number;
    patch: string;
    removed: number;
}

const ops = (kind: Op["kind"], lines: string[]): Op[] =>
    lines.map((line) => {
        return { kind, line };
    });

const splitLines = (text: string): string[] => {
    if (text === "") {
        return [];
    }

    const lines = text.split("\n");

    if (lines.at(-1) === "") {
        lines.pop();
    } else {
        lines[lines.length - 1] += NO_EOL;
    }

    return lines;
};

/** How many lines of `a[i..]` and `b[j..]` match, for every pair: the longest common subsequence table. */
const matchTable = (a: string[], b: string[]): Uint32Array => {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);

    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            const down = table[(i + 1) * width + j];
            const right = table[i * width + j + 1];

            table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(down, right);
        }
    }

    return table;
};

/** The edit script of two short runs of lines, walked along the table. */
const diffMiddle = (a: string[], b: string[]): Op[] => {
    if ((a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
        return [...ops("-", a), ...ops("+", b)];
    }

    const width = b.length + 1;
    const table = matchTable(a, b);
    const script: Op[] = [];
    let i = 0;
    let j = 0;

    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            script.push({ kind: " ", line: a[i] });
            i += 1;
            j += 1;
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            script.push({ kind: "-", line: a[i] });
            i += 1;
        } else {
            script.push({ kind: "+", line: b[j] });
            j += 1;
        }
    }

    return [...script, ...ops("-", a.slice(i)), ...ops("+", b.slice(j))];
};

const diffLines = (a: string[], b: string[]): Op[] => {
    let start = 0;

    while (start < a.length && start < b.length && a[start] === b[start]) {
        start += 1;
    }

    let endA = a.length;
    let endB = b.length;

    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }

    return [...ops(" ", a.slice(0, start)), ...diffMiddle(a.slice(start, endA), b.slice(start, endB)), ...ops(" ", a.slice(endA))];
};

const printLine = (op: Op): string => op.line.endsWith(NO_EOL) ? `${op.kind}${op.line.slice(0, -1)}\n\\ No newline at end of file` : `${op.kind}${op.line}`;

/** The stretches of the script that show a change with its context, nearby ones joined into one. */
const hunkRanges = (script: Op[]): { end: number; start: number }[] => {
    const ranges: { end: number; start: number }[] = [];

    for (const [index, op] of script.entries()) {
        if (op.kind === " ") {
            continue;
        }

        const start = Math.max(0, index - CONTEXT_LINES);
        const end = Math.min(script.length, index + CONTEXT_LINES + 1);
        const last = ranges.at(-1);

        if (last !== undefined && start <= last.end) {
            last.end = end;
        } else {
            ranges.push({ end, start });
        }
    }

    return ranges;
};

/** How many lines of one side come before each op: `kind` is the op kind that is NOT on that side. */
const linesBefore = (script: Op[], absent: Op["kind"]): number[] => {
    const counts: number[] = [];
    let seen = 0;

    for (const op of script) {
        counts.push(seen);
        seen += op.kind === absent ? 0 : 1;
    }

    return counts;
};

/** `null` for a side that does not exist (a created or a deleted file). Identical texts give no patch and zero counts. */
export const unifiedDiff = (path: string, before: string | null, after: string | null): FileDiff => {
    const script = diffLines(splitLines(before ?? ""), splitLines(after ?? ""));
    const added = script.filter((op) => op.kind === "+").length;
    const removed = script.filter((op) => op.kind === "-").length;

    if (added === 0 && removed === 0 && before === after) {
        return { added, patch: "", removed };
    }

    const oldBefore = linesBefore(script, "+");
    const newBefore = linesBefore(script, "-");
    const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`];

    for (const { end, start } of hunkRanges(script)) {
        const slice = script.slice(start, end);
        const oldLines = slice.filter((op) => op.kind !== "+").length;
        const newLines = slice.filter((op) => op.kind !== "-").length;
        // A side with no lines in the hunk is named by the line before it.
        const oldStart = oldBefore[start] + Math.sign(oldLines);
        const newStart = newBefore[start] + Math.sign(newLines);

        out.push(`@@ -${String(oldStart)},${String(oldLines)} +${String(newStart)},${String(newLines)} @@`, ...slice.map((op) => printLine(op)));
    }

    return { added, patch: `${out.join("\n")}\n`, removed };
};

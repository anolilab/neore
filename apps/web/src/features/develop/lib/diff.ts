export type DiffLineKind = "add" | "context" | "hunk" | "meta" | "remove";

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
}

/**
 * Splits a unified patch into lines tagged for colouring. A line is classified by its
 * first character only, so a line of file content that happens to start with `@@`
 * cannot be mistaken for a hunk header: content lines always carry a leading
 * `+`, `-` or space.
 */
export const parseDiffLines = (patch: string): DiffLine[] =>
    (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n").map((text) => {
        if (text.startsWith("@@")) {
            return { kind: "hunk", text };
        }

        if (text.startsWith("+")) {
            return { kind: "add", text };
        }

        if (text.startsWith("-")) {
            return { kind: "remove", text };
        }

        return { kind: text.startsWith("\\") ? "meta" : "context", text };
    });

export interface NumberedDiffLine extends DiffLine {
    /** The line's number in the file after the change; `null` for a removed line and for anything that is not file content. */
    newLine: number | null;
    /** The line's number in the file before the change; `null` for an added line and for anything that is not file content. */
    oldLine: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Tags each line of a patch as {@link parseDiffLines} does, and numbers each content line on both sides, counted from the
 * hunk headers. A line before the first header, or a content line that is empty (the patch's
 * trailing newline, not a blank line of the file: a blank context line is a single space),
 * has no number, so nothing can be commented on it.
 */
export const numberDiffLines = (patch: string): NumberedDiffLine[] => {
    let oldLine: number | null = null;
    let newLine: number | null = null;

    return parseDiffLines(patch).map((line) => {
        if (line.kind === "hunk") {
            const header = HUNK_HEADER.exec(line.text);

            oldLine = header ? Number(header[1]) : null;
            newLine = header ? Number(header[2]) : null;

            return { ...line, newLine: null, oldLine: null };
        }

        if (oldLine === null || newLine === null || line.kind === "meta" || (line.kind === "context" && !line.text.startsWith(" "))) {
            return { ...line, newLine: null, oldLine: null };
        }

        const numbered: NumberedDiffLine = {
            ...line,
            newLine: line.kind === "remove" ? null : newLine,
            oldLine: line.kind === "add" ? null : oldLine,
        };

        if (line.kind !== "remove") {
            newLine += 1;
        }

        if (line.kind !== "add") {
            oldLine += 1;
        }

        return numbered;
    });
};

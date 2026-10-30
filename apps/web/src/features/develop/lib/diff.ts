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
    patch.split("\n").map((text) => {
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

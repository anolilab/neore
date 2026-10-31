export type PatchLineKind = "add" | "context" | "header" | "hunk" | "remove";

export interface PatchLine {
    /** Unique within the patch. */
    id: string;
    kind: PatchLineKind;
    text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u;

/**
 * Sorts the lines of a unified diff into what they are. A line is an addition or a removal by where it sits, not by how
 * it starts: inside a hunk, whose header says how many lines it holds, a removed line of `-- comment` begins with
 * `---` and is still a removal; `---` and `+++` are file headers only between hunks.
 */
export const classifyPatch = (patch: string): PatchLine[] => {
    const lines = patch.split("\n");

    if (lines.at(-1) === "") {
        lines.pop();
    }

    let oldLeft = 0;
    let newLeft = 0;

    return lines.map((text, index): PatchLine => {
        const id = `line-${String(index)}`;

        if (oldLeft > 0 || newLeft > 0) {
            if (text.startsWith("+")) {
                newLeft -= 1;

                return { id, kind: "add", text };
            }

            if (text.startsWith("-")) {
                oldLeft -= 1;

                return { id, kind: "remove", text };
            }

            // A context line, or the "no newline" note, which counts for neither side.
            if (!text.startsWith("\\")) {
                oldLeft -= 1;
                newLeft -= 1;
            }

            return { id, kind: "context", text };
        }

        const hunk = HUNK_HEADER.exec(text);

        if (hunk) {
            oldLeft = Number(hunk[1] ?? 1);
            newLeft = Number(hunk[2] ?? 1);

            return { id, kind: "hunk", text };
        }

        return { id, kind: text.startsWith("---") || text.startsWith("+++") ? "header" : "context", text };
    });
};

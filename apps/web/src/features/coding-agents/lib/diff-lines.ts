/**
 * Classifying a unified diff line by line for the run view's diff viewer.
 *
 * Deliberately not a merge view: a run stores one unified patch (original and
 * modified files are not kept), and colouring lines needs no editor runtime.
 */

export type DiffLineKind = "added" | "context" | "file" | "hunk" | "meta" | "removed";

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
}

/** Lines rendered before the viewer asks to show the rest. */
export const DIFF_PREVIEW_LINES = 1500;

const META_LINE = /^(?:index |new file mode|deleted file mode|similarity index|rename (?:from|to) |Binary files |GIT binary patch)/u;

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/gmu;

export const classifyDiffLine = (line: string): DiffLineKind => {
    if (line.startsWith("diff --git ")) {
        return "file";
    }

    if (line.startsWith("@@")) {
        return "hunk";
    }

    if (line.startsWith("+++ ") || line.startsWith("--- ") || META_LINE.test(line)) {
        return "meta";
    }

    if (line.startsWith("+")) {
        return "added";
    }

    if (line.startsWith("-")) {
        return "removed";
    }

    return "context";
};

export const parseDiff = (diff: string): DiffLine[] => {
    const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");

    return lines.map((text) => {
        return { kind: classifyDiffLine(text), text };
    });
};

/** Files touched by the diff, in order, from its `diff --git a/x b/x` headers. */
export const diffFiles = (diff: string): string[] => Array.from(diff.matchAll(FILE_HEADER), (match) => match[2] ?? match[1] ?? "");

"use client";

import cn from "@neore/ui/utils/cn";

import type { DiffLineKind } from "../lib/diff";
import { parseDiffLines } from "../lib/diff";

const LINE_STYLE: Record<DiffLineKind, string> = {
    add: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    context: "",
    hunk: "bg-muted text-muted-foreground",
    meta: "text-muted-foreground italic",
    remove: "bg-red-500/10 text-red-700 dark:text-red-300",
};

/**
 * A unified patch, line by line. The patch is text from the host and goes in as text:
 * React escapes it, and nothing here parses it as markup.
 */
const DiffView = ({ patch }: { patch: string }) => (
    <pre className="overflow-x-auto font-mono text-xs leading-5">
        <code>
            {parseDiffLines(patch).map((line, index) => (
                // The patch is static text, so the line number is a stable key.

                // eslint-disable-next-line react-x/no-array-index-key
                <span className={cn("block min-w-full px-3 whitespace-pre", LINE_STYLE[line.kind])} key={index}>
                    {line.text === "" ? " " : line.text}
                </span>
            ))}
        </code>
    </pre>
);

export default DiffView;

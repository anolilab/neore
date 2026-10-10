"use client";

/**
 * Canvas Text Diff Viewer — Side-by-side read-only TipTap editors showing before/after.
 */

import { Trans } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { EditorContent, useEditor } from "@tiptap/react";
import type { FC } from "react";

import type { DiffCommit } from "../lib/diff-commit";
import { getCanvasExtensions } from "../lib/tiptap-extensions";

interface CanvasTextDiffViewerProps {
    className?: string;
    commit: DiffCommit;
}

const CanvasTextDiffViewer: FC<CanvasTextDiffViewerProps> = ({ className, commit }) => {
    const extensions = getCanvasExtensions();

    const beforeEditor = useEditor({
        content: commit.parent,
        editable: false,
        extensions,
        immediatelyRender: false,
    });

    const afterEditor = useEditor({
        content: commit.doc,
        editable: false,
        extensions,
        immediatelyRender: false,
    });

    return (
        <div className={cn("flex h-full overflow-auto", className)}>
            <div className="flex flex-1 flex-col overflow-auto">
                <div className="text-muted-foreground border-b px-4 py-2 text-xs font-medium">
                    <Trans>Before</Trans>
                </div>
                <div className="flex-1 overflow-auto p-4">
                    <EditorContent className="prose prose-sm dark:prose-invert max-w-none" editor={beforeEditor} />
                </div>
            </div>
            <div className="bg-border w-px shrink-0" />
            <div className="flex flex-1 flex-col overflow-auto">
                <div className="text-muted-foreground border-b px-4 py-2 text-xs font-medium">
                    <Trans>After</Trans>
                </div>
                <div className="flex-1 overflow-auto p-4">
                    <EditorContent className="prose prose-sm dark:prose-invert max-w-none" editor={afterEditor} />
                </div>
            </div>
        </div>
    );
};

export default CanvasTextDiffViewer;

"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";
import type { FC } from "react";
import { useId } from "react";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";

/** Hand the text to the browser as a `.md` download. */
const saveMarkdown = (markdown: string, filename: string): void => {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    // `appendChild`, not `append`: the Workers ambient types shadow the DOM `ParentNode.append` overload.
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};

/**
 * Downloads the user's memories as a Markdown file, built by the server from what is stored (pinned first, then by
 * type, with dates and where each came from). Shown with memory off too: what is stored can still be read.
 */
const MemoryExportButton: FC = () => {
    const { t } = useLingui();
    const errorId = useId();
    const { error, isPending, mutate } = useMutation({
        ...useLunoraActionOptions(api.memory.markdown_export.exportMemoriesMarkdown),
        onSuccess: ({ markdown }: { count: number; markdown: string; truncated: boolean }) => {
            saveMarkdown(markdown, `memories-${new Date().toISOString().slice(0, 10)}.md`);
        },
        retry: 0,
    });

    return (
        <div className="space-y-1">
            <Button
                aria-busy={isPending}
                aria-describedby={error ? errorId : undefined}
                className="w-full"
                disabled={isPending}
                // The button keeps focus while the file is prepared, so the keyboard is not sent back to the page.
                focusableWhenDisabled
                onClick={() => mutate({})}
                variant="outline"
            >
                <DownloadIcon aria-hidden="true" className="mr-2 h-4 w-4" />
                {isPending ? t`Preparing your memories…` : t`Download memories (Markdown)`}
            </Button>
            <span className="sr-only" role="status">
                {isPending ? t`Preparing your memories…` : ""}
            </span>
            {error && (
                <p className="text-destructive text-xs" id={errorId} role="alert">
                    {t`The download could not be prepared. Please try again in a moment.`}
                </p>
            )}
        </div>
    );
};

export default MemoryExportButton;

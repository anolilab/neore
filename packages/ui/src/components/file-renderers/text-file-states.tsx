"use client";

/**
 * The loading and failure states shared by the text previews (JSON Lines,
 * Mermaid, delimited tables). Kept apart so each preview reads the same way
 * while its file loads or when it cannot be shown.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { Download, FileText } from "lucide-react";
import type { FC } from "react";

export const TextFileLoading: FC = () => {
    const { t } = useLingui();

    return (
        <div aria-live="polite" className="space-y-2 p-4" role="status">
            <span className="sr-only">{t`Loading file…`}</span>
            <div aria-hidden="true" className="space-y-2">
                <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
                <div className="bg-muted h-4 w-full animate-pulse rounded" />
                <div className="bg-muted h-4 w-5/6 animate-pulse rounded" />
            </div>
        </div>
    );
};

TextFileLoading.displayName = "TextFileLoading";

export interface TextFileUnavailableProps {
    className?: string;
    filename?: string;
    url: string;
}

/** A link to the file itself, for when its preview cannot be shown. */
export const TextFileUnavailable: FC<TextFileUnavailableProps> = ({ className, filename, url }) => {
    const { t } = useLingui();

    return (
        <a
            className={cn(
                "group my-2 flex w-full max-w-sm items-center gap-3 rounded-lg border p-3 transition-colors",
                "hover:bg-accent hover:border-accent-foreground/20",
                className,
            )}
            download={filename}
            href={url}
            rel="noopener noreferrer"
            target="_blank"
        >
            <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                <FileText aria-hidden="true" className="text-muted-foreground size-5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{filename || t`File`}</div>
                <div className="text-muted-foreground text-xs">{t`Could not preview · Click to download`}</div>
            </div>
            <Download aria-hidden="true" className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
    );
};

TextFileUnavailable.displayName = "TextFileUnavailable";

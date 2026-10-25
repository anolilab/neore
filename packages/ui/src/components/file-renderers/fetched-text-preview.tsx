"use client";

/**
 * The frame shared by the text previews (JSON Lines, Mermaid, delimited
 * tables): a header with the file name and a download button, around a body
 * that is a loading skeleton until the file is read.
 *
 * `FetchedTextPreview` owns the fetch. A file that cannot be read, or is
 * larger than a preview reads (`MAX_FETCHED_TEXT_BYTES`), is shown as the
 * download card instead, so each preview supplies only its ready-state body.
 */

import { useLingui } from "@lingui/react/macro";
import { useFetchedText } from "@ui/hooks/use-fetched-text";
import cn from "@ui/utils/cn";
import { Download, FileText } from "lucide-react";
import type { FC, ReactNode } from "react";

import GenericFileCard from "./generic-file-card";

export interface FilePreviewFrameProps {
    children: ReactNode;
    className?: string;
    /** The title when the file has no name. */
    fallbackName: string;
    filename?: string;
    url: string;
}

export const FilePreviewFrame: FC<FilePreviewFrameProps> = ({ children, className, fallbackName, filename, url }) => {
    const { t } = useLingui();
    const displayName = filename || fallbackName;

    return (
        <div className={cn("my-2 w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            <div className="bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                    <FileText aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                    <span className="truncate text-xs font-medium">{displayName}</span>
                </div>
                <a
                    aria-label={t`Download ${displayName}`}
                    className="hover:bg-accent shrink-0 rounded p-1"
                    download={filename}
                    href={url}
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    <Download aria-hidden="true" className="size-3.5" />
                </a>
            </div>

            {children}
        </div>
    );
};

FilePreviewFrame.displayName = "FilePreviewFrame";

const TextFileLoading: FC = () => {
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

export interface FetchedTextPreviewProps {
    /** The ready-state body. A component of its own when it needs hooks: this is called only once the text is read. */
    children: (text: string) => ReactNode;
    className?: string;
    fallbackName: string;
    filename?: string;
    url: string;
}

export const FetchedTextPreview: FC<FetchedTextPreviewProps> = ({ children, className, fallbackName, filename, url }) => {
    const { t } = useLingui();
    const fetched = useFetchedText(url);

    if (fetched.status === "error") {
        return <GenericFileCard className={className} description={t`Could not preview · Click to download`} filename={filename} url={url} />;
    }

    return (
        <FilePreviewFrame className={className} fallbackName={fallbackName} filename={filename} url={url}>
            {fetched.status === "loading" ? <TextFileLoading /> : children(fetched.value)}
        </FilePreviewFrame>
    );
};

FetchedTextPreview.displayName = "FetchedTextPreview";

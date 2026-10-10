"use client";

import { useLingui } from "@lingui/react/macro";
import type { SandboxOutputFile, SandboxOutputs, SkippedSandboxFile } from "@neore/chat-ui/types";
import { formatFileSize } from "@neore/ui/components/file-renderers/file-type-utilities";
import { DownloadIcon, FileArchiveIcon, FileAudioIcon, FileIcon, FileImageIcon, FileSpreadsheetIcon, FileTextIcon, FileVideoIcon } from "lucide-react";
import type { FC, ReactNode } from "react";

/**
 * Files a code-execution or shell run saved to its output directory. Each
 * `url` is a signed URL once the message has been read back from the server
 * (`agent/display-media.ts`); while the reply is still streaming it is the raw
 * `storage:` reference, and a file its owner no longer holds comes back empty —
 * both render as a chip without a link.
 */

const HTTP_URL = /^https?:\/\//u;

const isLink = (url: string): boolean => HTTP_URL.test(url);

const ICON_CLASS = "text-muted-foreground size-4 shrink-0";

const isSpreadsheet = (mediaType: string): boolean =>
    mediaType === "text/csv" || mediaType === "text/tab-separated-values" || mediaType.includes("spreadsheetml");

const isDocument = (mediaType: string): boolean =>
    mediaType.startsWith("text/") || mediaType === "application/pdf" || mediaType === "application/json" || mediaType.includes("wordprocessingml");

/** An icon for the file's type; decorative, the name beside it says what it is. */
const fileIcon = (mediaType: string): ReactNode => {
    if (mediaType.startsWith("image/")) {
        return <FileImageIcon aria-hidden className={ICON_CLASS} />;
    }

    if (mediaType.startsWith("audio/")) {
        return <FileAudioIcon aria-hidden className={ICON_CLASS} />;
    }

    if (mediaType.startsWith("video/")) {
        return <FileVideoIcon aria-hidden className={ICON_CLASS} />;
    }

    if (isSpreadsheet(mediaType)) {
        return <FileSpreadsheetIcon aria-hidden className={ICON_CLASS} />;
    }

    if (mediaType === "application/zip") {
        return <FileArchiveIcon aria-hidden className={ICON_CLASS} />;
    }

    if (isDocument(mediaType)) {
        return <FileTextIcon aria-hidden className={ICON_CLASS} />;
    }

    return <FileIcon aria-hidden className={ICON_CLASS} />;
};

const SandboxFileChip: FC<{ file: SandboxOutputFile }> = ({ file }) => {
    const { t } = useLingui();
    const { name } = file;
    const size = formatFileSize(file.size);
    const body = (
        <>
            {fileIcon(file.mediaType)}
            <span className="min-w-0 truncate font-medium">{file.name}</span>
            <span className="text-muted-foreground shrink-0 text-xs">{size}</span>
        </>
    );

    if (!isLink(file.url)) {
        return (
            <li
                className="border-border text-muted-foreground flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
                title={t`Available once the reply is saved`}
            >
                {body}
            </li>
        );
    }

    return (
        <li className="max-w-full">
            <a
                aria-label={t`Download ${name} (${size})`}
                className="border-border hover:bg-muted flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors"
                download={file.name}
                href={file.url}
                rel="noopener noreferrer"
                target="_blank"
            >
                {body}
                <DownloadIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            </a>
        </li>
    );
};

const SandboxFiles: FC<SandboxOutputs> = ({ files, skippedFiles }) => {
    const { t } = useLingui();

    if (files.length === 0 && skippedFiles.length === 0) {
        return null;
    }

    const images = files.filter((file) => file.mediaType.startsWith("image/") && isLink(file.url));
    const reasonLabel = (reason: SkippedSandboxFile["reason"]): string => {
        switch (reason) {
            case "too-large": {
                return t`too large`;
            }

            case "too-many": {
                return t`too many files`;
            }

            case "total-too-large": {
                return t`size limit reached`;
            }

            case "unsupported-type": {
                return t`unsupported type`;
            }

            default: {
                return t`could not be saved`;
            }
        }
    };

    return (
        <div className="mb-4 space-y-2">
            {images.map((file) => (
                <img alt={file.name} className="border-border max-h-96 max-w-full rounded-lg border" key={file.url} loading="lazy" src={file.url} />
            ))}
            {files.length > 0 && (
                <ul aria-label={t`Output files`} className="flex flex-wrap gap-2">
                    {files.map((file) => (
                        <SandboxFileChip file={file} key={`${file.name}-${file.url}`} />
                    ))}
                </ul>
            )}
            {skippedFiles.length > 0 && (
                <p className="text-muted-foreground text-xs">
                    {t`Not attached:`} {skippedFiles.map((file) => `${file.name} (${reasonLabel(file.reason)})`).join(", ")}
                </p>
            )}
        </div>
    );
};

export default SandboxFiles;

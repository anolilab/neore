"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { Download, File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo } from "lucide-react";
import type { FC } from "react";
import { memo, useMemo } from "react";

import { formatFileSize } from "./file-type-utilities";

export interface GenericFileCardProps {
    className?: string;
    filename?: string;
    fileSize?: number;
    mediaType?: string;
    url?: string;
}

const ICON_MAP: Record<string, FC<{ className?: string }>> = {
    "application/gzip": FileArchive,
    "application/json": FileCode,
    "application/pdf": FileText,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": FileText,
    "application/xml": FileCode,
    "application/zip": FileArchive,
    "text/csv": FileSpreadsheet,
    "text/html": FileCode,
    "text/plain": FileText,
};

const getIconForFile = (mediaType?: string, filename?: string): FC<{ className?: string }> => {
    if (mediaType) {
        if (ICON_MAP[mediaType]) {
            return ICON_MAP[mediaType];
        }

        if (mediaType.startsWith("image/")) {
            return FileImage;
        }

        if (mediaType.startsWith("video/")) {
            return FileVideo;
        }

        if (mediaType.startsWith("audio/")) {
            return FileAudio;
        }

        if (mediaType.startsWith("text/")) {
            return FileText;
        }
    }

    const extension = filename?.split(".").pop()?.toLowerCase() ?? "";
    const extensionMap: Record<string, FC<{ className?: string }>> = {
        csv: FileSpreadsheet,
        doc: FileText,
        docx: FileText,
        gz: FileArchive,
        html: FileCode,
        js: FileCode,
        json: FileCode,
        md: FileText,
        mp3: FileAudio,
        mp4: FileVideo,
        pdf: FileText,
        py: FileCode,
        rar: FileArchive,
        ts: FileCode,
        tsx: FileCode,
        txt: FileText,
        wav: FileAudio,
        webm: FileVideo,
        xlsx: FileSpreadsheet,
        xml: FileCode,
        zip: FileArchive,
    };

    return extensionMap[extension] ?? File;
};

const GenericFileCard: FC<GenericFileCardProps> = memo(({ className, filename, fileSize, mediaType, url }) => {
    const { t } = useLingui();
    const Icon = useMemo(() => getIconForFile(mediaType, filename), [mediaType, filename]);
    const displayName = filename || t`Download file`;

    return (
        <a
            aria-label={t`Download ${displayName}`}
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
                <Icon aria-hidden="true" className="text-muted-foreground size-5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{displayName}</div>
                <div className="text-muted-foreground text-xs">
                    {mediaType && <span>{mediaType}</span>}
                    {mediaType && fileSize != null && " · "}
                    {fileSize != null && <span>{formatFileSize(fileSize)}</span>}
                </div>
            </div>
            <Download aria-hidden="true" className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
    );
});

GenericFileCard.displayName = "GenericFileCard";

export default GenericFileCard;

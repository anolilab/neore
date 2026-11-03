"use client";

/**
 * A PDF's first page at a small size, with its page count. Opening it is the caller's choice; the thumbnail only
 * reports the click. Lazy-loaded with the viewer's worker (`pdf-worker.ts`).
 */

import "./pdf-worker";

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import type { FC } from "react";
import { useState } from "react";
import { Document, Page } from "react-pdf";

const THUMBNAIL_WIDTH = 200;

export interface PdfThumbnailProps {
    className?: string;
    filename?: string;
    onOpen: () => void;
    url: string;
}

const PdfThumbnail: FC<PdfThumbnailProps> = ({ className, filename, onOpen, url }) => {
    const { t } = useLingui();
    const [pages, setPages] = useState(0);
    const [failed, setFailed] = useState(false);

    return (
        <button
            aria-label={filename ? t`Open ${filename}` : t`Open PDF`}
            className={cn("bg-muted/40 hover:bg-muted/70 flex w-fit max-w-full flex-col items-center gap-2 rounded-lg border p-2 text-left", className)}
            onClick={onOpen}
            type="button"
        >
            {failed ? (
                <span className="text-muted-foreground w-[200px] p-6 text-sm">{t`This preview could not be loaded.`}</span>
            ) : (
                <Document
                    error={<span className="text-muted-foreground w-[200px] p-6 text-sm">{t`This preview could not be loaded.`}</span>}
                    file={url}
                    loading={<span aria-hidden="true" className="bg-muted block h-[260px] w-[200px] animate-pulse rounded" />}
                    onLoadError={() => setFailed(true)}
                    onLoadSuccess={({ numPages }: { numPages: number }) => setPages(numPages)}
                >
                    <Page pageNumber={1} renderAnnotationLayer={false} renderTextLayer={false} width={THUMBNAIL_WIDTH} />
                </Document>
            )}
            {pages > 0 && (
                <span className="text-muted-foreground text-xs tabular-nums">
                    {pages} {pages === 1 ? t`page` : t`pages`}
                </span>
            )}
        </button>
    );
};

export default PdfThumbnail;

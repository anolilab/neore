"use client";

/**
 * A PDF's first page at a small size, with its page count. Opening it is the caller's choice; the thumbnail only
 * reports the click. Lazy-loaded with the viewer's worker (`pdf-worker.ts`).
 */

import "./pdf-worker";

import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { isFetchableUrl, useFetchableOrigins } from "@ui/hooks/use-fetchable-origins";
import cn from "@ui/utils/cn";
import type { FC } from "react";
import { useEffect, useState } from "react";
import { Document, Page } from "react-pdf";

import { PDF_LOAD_TIMEOUT_MS } from "./pdf-limits";

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
    // Each progress report restarts the deadline, so a large file that is still arriving is not failed. A URL the page may not
    // fetch is refused before any request, the way the text previews refuse it.
    const [progress, setProgress] = useState(0);
    const origins = useFetchableOrigins();
    const refused = !isFetchableUrl(url, origins);
    const unavailable = failed || refused;
    const loading = !unavailable && pages === 0;

    useEffect(() => {
        if (!loading) {
            return undefined;
        }

        const timer = setTimeout(setFailed, PDF_LOAD_TIMEOUT_MS, true);

        return () => clearTimeout(timer);
    }, [loading, progress]);

    const name = filename ? t`Open ${filename}` : t`Open PDF`;
    const pagesLabel = pages > 0 ? t`${name}, ${plural(pages, { one: "# page", other: "# pages" })}` : name;
    const label = unavailable ? t`${name}, preview unavailable` : pagesLabel;

    return (
        <button
            aria-busy={loading}
            aria-label={label}
            className={cn("bg-muted/40 hover:bg-muted/70 flex w-fit max-w-full flex-col items-center gap-2 rounded-lg border p-2 text-left", className)}
            onClick={onOpen}
            type="button"
        >
            {unavailable ? (
                <span className="text-muted-foreground w-[200px] p-6 text-sm" role="status">
                    {t`This preview could not be loaded.`}
                </span>
            ) : (
                <Document
                    error={<span className="text-muted-foreground w-[200px] p-6 text-sm">{t`This preview could not be loaded.`}</span>}
                    file={url}
                    loading={<span aria-hidden="true" className="bg-muted block h-[260px] w-[200px] animate-pulse rounded" />}
                    onLoadError={() => setFailed(true)}
                    onLoadProgress={() => setProgress((count) => count + 1)}
                    onLoadSuccess={({ numPages }: { numPages: number }) => setPages(numPages)}
                    // Like the viewer: its own loading and error UI, not the nearest Suspense boundary.
                    suspense={false}
                >
                    <Page pageNumber={1} renderAnnotationLayer={false} renderTextLayer={false} width={THUMBNAIL_WIDTH} />
                </Document>
            )}
            {pages > 0 && (
                <span className="text-muted-foreground text-xs tabular-nums">
                    <Plural one="# page" other="# pages" value={pages} />
                </span>
            )}
        </button>
    );
};

export default PdfThumbnail;

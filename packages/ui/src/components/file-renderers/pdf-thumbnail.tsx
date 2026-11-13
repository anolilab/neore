"use client";

/**
 * A PDF's first page at a small size, with its page count. Opening it is the caller's choice; the thumbnail only
 * reports the click. Lazy-loaded with the viewer's worker (`pdf-worker.ts`), which every thumbnail shares; a drawn
 * page is cached by file (`pdf-thumbnail-cache.ts`), so a thumbnail that mounts again shows it at once.
 */

import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { isFetchableUrl, useFetchableOrigins } from "@ui/hooks/use-fetchable-origins";
import cn from "@ui/utils/cn";
import { pdfFileKey } from "@ui/utils/pdf-preview-event";
import { cachePdfThumbnail, pdfThumbnailCacheGeneration, peekCachedPdfThumbnail, touchCachedPdfThumbnail } from "@ui/utils/pdf-thumbnail-cache";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import { Document, Page } from "react-pdf";

import { PDF_LOAD_TIMEOUT_MS } from "./pdf-limits";
import { sharedPdfOptions } from "./pdf-worker";

const THUMBNAIL_WIDTH = 200;

/** The drawn first page as an image URL, or nothing when the canvas cannot be read (the document then stays mounted). */
const snapshotOf = (canvas: HTMLCanvasElement | null): string | undefined => {
    try {
        return canvas?.toDataURL("image/png");
    } catch {
        return undefined;
    }
};

export interface PdfThumbnailProps {
    className?: string;
    filename?: string;
    /** Called with the thumbnail's button, so the caller can return focus to it. */
    onOpen: (opener: HTMLElement) => void;
    url: string;
}

const PdfThumbnail: FC<PdfThumbnailProps> = ({ className, filename, onOpen, url }) => {
    const { t } = useLingui();
    const fileKey = pdfFileKey(url);
    // A thumbnail drawn before (this file, any signature) starts out drawn: no document, no worker, no placeholder.
    // Read-only here (a render can be discarded); the effect below marks the entry used once this thumbnail mounts.
    const [cached] = useState(() => peekCachedPdfThumbnail(fileKey));
    // The cache's generation when this thumbnail's draw starts: a sign-out (cache clear) before it finishes discards it.
    const [cacheGeneration] = useState(pdfThumbnailCacheGeneration);
    const [pages, setPages] = useState(cached?.pages ?? 0);
    const [rendered, setRendered] = useState(cached !== undefined);
    const [failed, setFailed] = useState(false);
    // Once the first page is drawn it is kept as an image and the PDF document is let go: a thread of thumbnails holds no
    // parsed documents, and opening one in the side panel does not leave a second copy of it loaded here.
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [snapshot, setSnapshot] = useState<string | undefined>(cached?.snapshot);
    // Each progress report restarts the deadline, so a large file that is still arriving is not failed. A URL the page may not
    // fetch is refused before any request, the way the text previews refuse it.
    const [progress, setProgress] = useState(0);
    const origins = useFetchableOrigins();
    const refused = !isFetchableUrl(url, origins);
    const unavailable = failed || refused;
    // Loading ends when the first page has rendered, not when the page count arrives: a page that never renders is failed too.
    const loading = !unavailable && !rendered;

    useEffect(() => {
        if (!loading) {
            return undefined;
        }

        const timer = setTimeout(setFailed, PDF_LOAD_TIMEOUT_MS, true);

        return () => clearTimeout(timer);
    }, [loading, progress]);

    useEffect(() => {
        if (cached) {
            touchCachedPdfThumbnail(fileKey, cached, cacheGeneration);
        }
    }, [cacheGeneration, cached, fileKey]);

    // Kept once both the drawn page and the page count are in, whichever arrives last. A thumbnail shown from the cache
    // writes nothing: its entry is already there, and marking it used is the effect above's job.
    useEffect(() => {
        if (snapshot && pages > 0 && (snapshot !== cached?.snapshot || pages !== cached.pages)) {
            cachePdfThumbnail(fileKey, { pages, snapshot }, cacheGeneration);
        }
    }, [cacheGeneration, cached, fileKey, pages, snapshot]);

    const name = filename ? t`Open ${filename}` : t`Open PDF`;
    const pagesLabel = pages > 0 ? t`${name}, ${plural(pages, { one: "# page", other: "# pages" })}` : name;
    const label = unavailable ? t`${name}, preview unavailable` : pagesLabel;

    return (
        <button
            aria-busy={loading}
            aria-label={label}
            className={cn("bg-muted/40 hover:bg-muted/70 flex w-fit max-w-full flex-col items-center gap-2 rounded-lg border p-2 text-left", className)}
            // The file, not its signed URL: a side panel finds this button again after the message re-signs it and it remounts.
            data-pdf-file={fileKey}
            onClick={(event) => onOpen(event.currentTarget)}
            type="button"
        >
            {snapshot && !unavailable && <img alt="" className="rounded" src={snapshot} width={THUMBNAIL_WIDTH} />}
            {unavailable && (
                <span className="text-muted-foreground w-[200px] p-6 text-sm" role="status">
                    {t`This preview could not be loaded.`}
                </span>
            )}
            {!unavailable && !snapshot && (
                <Document
                    error={<span className="text-muted-foreground w-[200px] p-6 text-sm">{t`This preview could not be loaded.`}</span>}
                    file={url}
                    loading={<span aria-hidden="true" className="bg-muted block h-[260px] w-[200px] animate-pulse rounded motion-reduce:animate-none" />}
                    onLoadError={() => setFailed(true)}
                    onLoadProgress={() => setProgress((count) => count + 1)}
                    onLoadSuccess={({ numPages }: { numPages: number }) => setPages(numPages)}
                    options={sharedPdfOptions()}
                    // Like the viewer: its own loading and error UI, not the nearest Suspense boundary.
                    suspense={false}
                >
                    <Page
                        canvasRef={canvasRef}
                        onLoadError={() => setFailed(true)}
                        onRenderError={() => setFailed(true)}
                        onRenderSuccess={() => {
                            setRendered(true);
                            setSnapshot(snapshotOf(canvasRef.current));
                        }}
                        pageNumber={1}
                        renderAnnotationLayer={false}
                        renderTextLayer={false}
                        width={THUMBNAIL_WIDTH}
                    />
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

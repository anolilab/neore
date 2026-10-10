"use client";

/**
 * PDF Viewer — code-split, lazy-loaded.
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));
 * ```
 */

import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { ChevronLeft, ChevronRight, Minus, Plus, ZoomIn } from "lucide-react";
// Emitted by Vite as a hashed asset next to this chunk. `new URL("pdfjs-dist/…",
// import.meta.url)` resolved RELATIVE to this file (packages/ui/src/…), which does
// not exist: the worker 404'd at runtime and every PDF failed to load. The
// `pdfjs-dist` dependency must stay at exactly the version react-pdf depends on,
// or the API and worker versions disagree and pdf.js refuses to start.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { FC } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfViewerProps {
    className?: string;
    filename?: string;
    url: string;
}

const PdfViewer: FC<PdfViewerProps> = memo(({ className, filename, url }) => {
    const { t } = useLingui();
    const [numberPages, setNumberPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState(1);
    const [scale, setScale] = useState(1);
    const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);

    const onDocumentLoadSuccess = useCallback(({ numPages: total }: { numPages: number }) => {
        setNumberPages(total);
    }, []);

    useEffect(() => {
        if (!containerRef.current) {
            return undefined;
        }

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });

        observer.observe(containerRef.current);

        return () => observer.disconnect();
    }, []);

    const goToPrevPage = useCallback(() => setPageNumber((p) => Math.max(1, p - 1)), []);
    const goToNextPage = useCallback(() => setPageNumber((p) => Math.min(numberPages, p + 1)), [numberPages]);
    const zoomIn = useCallback(() => setScale((s) => Math.min(3, s + 0.25)), []);
    const zoomOut = useCallback(() => setScale((s) => Math.max(0.5, s - 0.25)), []);

    // Calculate page width: fit to container at scale 1
    const pageWidth = containerWidth ? (containerWidth - 32) * scale : undefined;

    return (
        <div className={cn("my-2 w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            {/* Toolbar */}
            <div className="bg-muted/50 flex items-center justify-between border-b px-3 py-1.5">
                <div className="flex items-center gap-1">
                    <button
                        aria-label={t`Previous page`}
                        className="hover:bg-accent rounded p-1 disabled:opacity-40"
                        disabled={pageNumber <= 1}
                        onClick={goToPrevPage}
                        type="button"
                    >
                        <ChevronLeft aria-hidden="true" className="size-4" />
                    </button>
                    <span aria-live="polite" className="text-xs tabular-nums" role="status">
                        {pageNumber}
                        {" / "}
                        {numberPages || "–"}
                    </span>
                    <button
                        aria-label={t`Next page`}
                        className="hover:bg-accent rounded p-1 disabled:opacity-40"
                        disabled={pageNumber >= numberPages}
                        onClick={goToNextPage}
                        type="button"
                    >
                        <ChevronRight aria-hidden="true" className="size-4" />
                    </button>
                </div>

                <div className="flex items-center gap-1">
                    <button
                        aria-label={t`Zoom out`}
                        className="hover:bg-accent rounded p-1 disabled:opacity-40"
                        disabled={scale <= 0.5}
                        onClick={zoomOut}
                        type="button"
                    >
                        <Minus aria-hidden="true" className="size-4" />
                    </button>
                    <span className="text-xs tabular-nums">{Math.round(scale * 100)}%</span>
                    <button
                        aria-label={t`Zoom in`}
                        className="hover:bg-accent rounded p-1 disabled:opacity-40"
                        disabled={scale >= 3}
                        onClick={zoomIn}
                        type="button"
                    >
                        <Plus aria-hidden="true" className="size-4" />
                    </button>
                </div>

                {filename && <span className="text-muted-foreground max-w-[120px] truncate text-xs">{filename}</span>}
            </div>

            {/* PDF Content */}
            <div className="overflow-auto bg-gray-100 p-4 dark:bg-gray-900" ref={containerRef} style={{ maxHeight: "600px" }}>
                <Document
                    file={url}
                    loading={
                        <div className="flex items-center justify-center py-12">
                            <ZoomIn className="text-muted-foreground size-6 animate-pulse" />
                        </div>
                    }
                    onLoadSuccess={onDocumentLoadSuccess}
                    // react-pdf 11 suspends by default; keep the inline `loading` UI instead.
                    suspense={false}
                >
                    <Page pageNumber={pageNumber} renderAnnotationLayer renderTextLayer width={pageWidth} />
                </Document>
            </div>
        </div>
    );
});

PdfViewer.displayName = "PdfViewer";

export default PdfViewer;

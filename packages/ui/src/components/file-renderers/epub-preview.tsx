"use client";

/**
 * EPUB Preview — code-split, lazy-loaded.
 * Shows a book's chapters in reading order, one at a time, with previous and next controls.
 *
 * Each chapter is shown in a frame with an empty `sandbox`: no scripts, no same origin, no forms, no popups. That frame is the whole
 * boundary: the chapter's markup is not cleaned, so a script in it never runs (`epub-book.ts` also sets a policy that refuses every
 * request). A file larger than `maxBytes` (the office-file cap by default) is refused before it is parsed.
 *
 * NOT exported from the barrel index. Import directly:
 *
 * ```tsx
 * const EpubPreview = lazy(() => import("@neore/ui/components/file-renderers/epub-preview"));
 * ```
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { assertOfficeZipWithinLimits, OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES } from "@ui/utils/office-zip-limits";
import { saveOnClick } from "@ui/utils/save-from-url";
import { BookOpen, ChevronLeft, ChevronRight, Download } from "lucide-react";
import type { FC } from "react";
import { memo, useEffect, useState } from "react";

import type { OpenedEpub } from "./epub-book";
import { openEpub } from "./epub-book";
import GenericFileCard from "./generic-file-card";

export interface EpubPreviewProps {
    className?: string;
    filename?: string;
    /** The largest file shown; a larger one is refused before anything is read from it. */
    maxBytes?: number;
    url: string;
}

const EPUB_FETCH_TIMEOUT_MS = 30_000;
const EPUB_MEDIA_TYPE = "application/epub+zip";

type Load = { status: "failed" } | { status: "loading" } | { book: OpenedEpub; status: "ready" } | { status: "too-large" };

const TooLarge = new Error("too large");

const fetchBook = async (url: string, maxBytes: number, signal: AbortSignal): Promise<OpenedEpub> => {
    const response = await fetch(url, { signal });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    // Refused from the header when it names a size, so a huge file is not downloaded to be refused.
    const declared = Number(response.headers.get("content-length"));

    if (declared > maxBytes) {
        throw TooLarge;
    }

    const buffer = await response.arrayBuffer();

    if (buffer.byteLength > maxBytes) {
        throw TooLarge;
    }

    await assertOfficeZipWithinLimits(buffer);

    return await openEpub(new Uint8Array(buffer));
};

const EpubPreview: FC<EpubPreviewProps> = memo(({ className, filename, maxBytes = OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES, url }) => {
    const { t } = useLingui();
    // The result carries the URL it belongs to: a book from an earlier file is never shown for this one.
    const [loaded, setLoaded] = useState<{ load: Load; url: string }>({ load: { status: "loading" }, url });
    const [shown, setShown] = useState<{ doc: string; id: string; url: string } | undefined>();
    const [position, setPosition] = useState({ index: 0, url });
    const load: Load = loaded.url === url ? loaded.load : { status: "loading" };
    const index = position.url === url ? position.index : 0;

    useEffect(() => {
        const controller = new AbortController();
        let opened: OpenedEpub | undefined;
        let cancelled = false;
        // A deadline as well as the unmount abort: a stalled URL must not hold the preview forever.
        const deadline = setTimeout(() => controller.abort(), EPUB_FETCH_TIMEOUT_MS);

        const run = async (): Promise<void> => {
            try {
                opened = await fetchBook(url, maxBytes, controller.signal);

                if (cancelled) {
                    opened.destroy();

                    return;
                }

                setLoaded({ load: opened.chapters.length > 0 ? { book: opened, status: "ready" } : { status: "failed" }, url });
            } catch (error) {
                if (!cancelled) {
                    setLoaded({ load: error === TooLarge ? { status: "too-large" } : { status: "failed" }, url });
                }
            } finally {
                clearTimeout(deadline);
            }
        };

        run().catch(() => undefined);

        return () => {
            cancelled = true;
            clearTimeout(deadline);
            controller.abort();
            opened?.destroy();
        };
    }, [maxBytes, url]);

    const chapter = load.status === "ready" ? load.book.chapters[index] : undefined;
    const chapterId = chapter?.id;
    const book = load.status === "ready" ? load.book : undefined;

    useEffect(() => {
        if (book === undefined || chapterId === undefined) {
            return undefined;
        }

        let cancelled = false;

        const show = async (): Promise<void> => {
            try {
                const doc = await book.read(chapterId);

                if (!cancelled) {
                    setShown({ doc, id: chapterId, url });
                }
            } catch {
                if (!cancelled) {
                    setLoaded({ load: { status: "failed" }, url });
                }
            }
        };

        show().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [book, chapterId, url]);

    if (load.status === "failed" || load.status === "too-large") {
        return (
            <GenericFileCard
                className={className}
                description={load.status === "too-large" ? t`Too large to preview · Click to download` : t`Could not preview · Click to download`}
                filename={filename}
                mediaType={EPUB_MEDIA_TYPE}
                url={url}
            />
        );
    }

    const total = load.status === "ready" ? load.book.chapters.length : 0;
    const label = t`Chapter ${index + 1} of ${total}`;
    const go = (to: number) => setPosition({ index: to, url });

    return (
        <div className={cn("my-2 w-full max-w-2xl overflow-hidden rounded-lg border", className)}>
            <div className="bg-muted/50 flex items-center justify-between border-b px-3 py-1.5">
                <div className="flex items-center gap-2">
                    <BookOpen aria-hidden="true" className="text-muted-foreground size-4" />
                    <span className="max-w-[200px] truncate text-xs font-medium">{filename || t`Document`}</span>
                </div>
                <a
                    aria-label={filename ? t`Download ${filename}` : t`Download document`}
                    className="hover:bg-accent rounded p-1"
                    download={filename}
                    href={url}
                    onClick={saveOnClick(url, filename, "book.epub")}
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    <Download aria-hidden="true" className="size-3.5" />
                </a>
            </div>

            {load.status === "loading" ? (
                <div aria-live="polite" className="p-4" role="status">
                    <span className="sr-only">{t`Loading preview…`}</span>
                    <div aria-hidden="true" className="space-y-3">
                        <div className="bg-muted h-4 w-3/4 animate-pulse rounded motion-reduce:animate-none" />
                        <div className="bg-muted h-4 w-full animate-pulse rounded motion-reduce:animate-none" />
                        <div className="bg-muted h-4 w-2/3 animate-pulse rounded motion-reduce:animate-none" />
                    </div>
                </div>
            ) : (
                <>
                    {/* An empty `sandbox` is the strictest one: no `allow-scripts`, no `allow-same-origin`. Never add either. */}
                    <iframe
                        className="bg-background h-[500px] w-full border-0"
                        referrerPolicy="no-referrer"
                        sandbox=""
                        srcDoc={shown !== undefined && shown.id === chapterId && shown.url === url ? shown.doc : undefined}
                        title={chapter?.title ?? label}
                    />
                    <div className="bg-muted/50 flex items-center justify-between gap-2 border-t px-3 py-1.5">
                        <button
                            aria-label={t`Previous chapter`}
                            className="hover:bg-accent rounded p-1 disabled:opacity-40"
                            disabled={index <= 0}
                            onClick={() => go(index - 1)}
                            type="button"
                        >
                            <ChevronLeft aria-hidden="true" className="size-4" />
                        </button>
                        <span aria-live="polite" className="min-w-0 truncate text-xs tabular-nums" role="status">
                            {chapter?.title === undefined ? label : `${label} · ${chapter.title}`}
                        </span>
                        <button
                            aria-label={t`Next chapter`}
                            className="hover:bg-accent rounded p-1 disabled:opacity-40"
                            disabled={index >= total - 1}
                            onClick={() => go(index + 1)}
                            type="button"
                        >
                            <ChevronRight aria-hidden="true" className="size-4" />
                        </button>
                    </div>
                </>
            )}
        </div>
    );
});

EpubPreview.displayName = "EpubPreview";

export default EpubPreview;

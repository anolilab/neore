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
import { isFetchableUrl, useFetchableOrigins } from "@ui/hooks/use-fetchable-origins";
import cn from "@ui/utils/cn";
import { assertOfficeZipWithinLimits, OFFICE_ZIP_MAX_ENTRIES, OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES } from "@ui/utils/office-zip-limits";
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

/** The zip guard's refusals that say a book is too big (the rest say it is not a book): shown as too large, not as a failure. */
const OVERSIZE_MESSAGE = /too large|too many entries/iu;

/** The body, read as it arrives and refused once it passes `maxBytes`: a missing or understated length cannot make it all be held. */
const readCapped = async (response: Response, maxBytes: number): Promise<ArrayBuffer> => {
    const reader = response.body?.getReader();

    if (reader === undefined) {
        const buffer = await response.arrayBuffer();

        if (buffer.byteLength > maxBytes) {
            throw TooLarge;
        }

        return buffer;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        total += chunk.value.byteLength;

        if (total > maxBytes) {
            await reader.cancel();

            throw TooLarge;
        }

        chunks.push(chunk.value);
    }

    const bytes = new Uint8Array(total);
    let at = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
    }

    return bytes.buffer;
};

const fetchBook = async (url: string, maxBytes: number, signal: AbortSignal): Promise<OpenedEpub> => {
    const response = await fetch(url, { signal });

    if (!response.ok) {
        // An error answer may stream: it is let go, not left holding the connection.
        await response.body?.cancel().catch(() => undefined);

        throw new Error(`HTTP ${response.status}`);
    }

    // Refused from the header when it names a size, so a huge file is not downloaded to be refused.
    const declared = Number(response.headers.get("content-length"));

    if (declared > maxBytes) {
        // Not read, and not left open either: the connection is let go.
        await response.body?.cancel().catch(() => undefined);

        throw TooLarge;
    }

    const buffer = await readCapped(response, maxBytes);

    try {
        // The caller's cap, for what the archive expands to as well: the guard's own default is the office-file one.
        await assertOfficeZipWithinLimits(buffer, { maxBytes, maxEntries: OFFICE_ZIP_MAX_ENTRIES });
    } catch (error) {
        const message = error instanceof Error ? error.message : "";

        throw OVERSIZE_MESSAGE.test(message) ? TooLarge : error;
    }

    return await openEpub(new Uint8Array(buffer));
};

/** A chapter's read waits at most this long: a stalled picture or style sheet ends in the failure card, not an empty frame. */
const CHAPTER_DEADLINE_MS = 30_000;

const EpubPreview: FC<EpubPreviewProps> = memo(({ className, filename, maxBytes = OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES, url }) => {
    const { t } = useLingui();
    // Only the app's own file addresses are read (the same allowance the PDF viewer has): a file part or sandbox output that names another
    // origin, a loopback service or a scheme the app does not serve is refused without a request.
    const origins = useFetchableOrigins();
    const refused = !isFetchableUrl(url, origins);
    // A result belongs to the file AND the cap it was read under: a book read for another file, or under another cap, is never shown for this
    // one, and a book whose load was torn down (the effect's cleanup destroys it) is not one to show again if the same file comes back.
    const key = `${url}\n${String(maxBytes)}`;
    const [loaded, setLoaded] = useState<{ key: string; load: Load }>({ key, load: { status: "loading" } });
    const [shown, setShown] = useState<{ book: OpenedEpub; doc: string; failed?: boolean; id: string; key: string } | undefined>();
    const [position, setPosition] = useState({ index: 0, key });
    const isLive = loaded.key === key && !(loaded.load.status === "ready" && loaded.load.book.destroyed);
    const load: Load = isLive ? loaded.load : { status: "loading" };
    const index = position.key === key ? position.index : 0;

    useEffect(() => {
        if (refused) {
            return undefined;
        }

        const controller = new AbortController();
        let opened: OpenedEpub | undefined;
        let cancelled = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;

        const run = async (): Promise<void> => {
            const loading = fetchBook(url, maxBytes, controller.signal);

            try {
                // A deadline for the whole load, parsing included: the abort stops the download, and the race settles a load that is stuck in
                // the archive guard or the parser, which take no signal.
                const timeout = new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => {
                        controller.abort();
                        reject(new Error("load timed out"));
                    }, EPUB_FETCH_TIMEOUT_MS);
                });

                opened = await Promise.race([loading, timeout]);

                if (cancelled) {
                    opened.destroy();

                    return;
                }

                // A book with nothing to read is not kept: its parsed archive goes with it.
                if (opened.chapters.length === 0) {
                    opened.destroy();
                    setLoaded({ key, load: { status: "failed" } });

                    return;
                }

                setLoaded({ key, load: { book: opened, status: "ready" } });
            } catch (error) {
                // A book that arrives after the deadline is released, not shown.
                loading.then((late) => late.destroy()).catch(() => undefined);

                if (!cancelled) {
                    setLoaded({ key, load: error === TooLarge ? { status: "too-large" } : { status: "failed" } });
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
    }, [key, maxBytes, refused, url]);

    const chapter = load.status === "ready" ? load.book.chapters[index] : undefined;
    const chapterId = chapter?.id;
    const book = load.status === "ready" ? load.book : undefined;

    useEffect(() => {
        if (book === undefined || chapterId === undefined) {
            return undefined;
        }

        let cancelled = false;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const show = async (): Promise<void> => {
            try {
                // Raced with a deadline as well as handed the signal: the parser's own reads take no signal, so a stalled one must not hold this.
                const timeout = new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new Error("chapter read timed out"));
                    }, CHAPTER_DEADLINE_MS);
                });
                const doc = await Promise.race([book.read(chapterId, controller.signal), timeout]);

                if (!cancelled) {
                    setShown({ book, doc, id: chapterId, key });
                }
            } catch {
                if (!cancelled) {
                    // This chapter could not be read (it is missing from the archive, too large, or stalled): the others still can be, so the book
                    // is kept and only this chapter is marked.
                    setShown({ book, doc: "", failed: true, id: chapterId, key });
                }
            } finally {
                clearTimeout(timer);
            }
        };

        show().catch(() => undefined);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            controller.abort();
        };
    }, [book, chapterId, key]);

    const tooLarge = !refused && load.status === "too-large";

    if (refused || load.status === "failed" || tooLarge) {
        return (
            <GenericFileCard
                className={className}
                description={tooLarge ? t`Too large to preview · Click to download` : t`Could not preview · Click to download`}
                filename={filename}
                mediaType={EPUB_MEDIA_TYPE}
                url={url}
            />
        );
    }

    const total = load.status === "ready" ? load.book.chapters.length : 0;
    const label = t`Chapter ${index + 1} of ${total}`;
    const go = (to: number) => setPosition({ index: to, key });

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
                        srcDoc={shown !== undefined && shown.book === book && shown.id === chapterId && shown.key === key ? shown.doc : undefined}
                        title={chapter?.title ?? label}
                    />
                    {shown?.failed === true && shown.book === book && shown.id === chapterId && shown.key === key && (
                        <p className="text-destructive px-3 py-1 text-xs" role="status">
                            {t`Could not preview · Click to download`}
                        </p>
                    )}
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

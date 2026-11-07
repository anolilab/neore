import { useLingui } from "@lingui/react/macro";
import { chatAttachmentLimit } from "@neore/backend/document-limits";
import { FetchableOriginsProvider } from "@neore/ui/components/file-renderers/fetchable-origins-provider";
import { isFetchableUrl, originsOf } from "@neore/ui/hooks/use-fetchable-origins";
import cn from "@neore/ui/utils/cn";
import { latestPdfUrl } from "@neore/ui/utils/pdf-preview-event";
import { Download, ExternalLink, X } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { ErrorBoundary } from "@/components/error-boundary";
import type { PreviewFile } from "@/features/chat/core/stores/chat-ui-store";
import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";
import { showError } from "@/lib/toast";

const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));

// The backend serves the signed storage URLs, so its origin is the one the viewer and the download may fetch from.
const PANEL_ORIGINS = originsOf(import.meta.env.VITE_LUNORA_URL as string | undefined);

/** The most a chat PDF can weigh: the upload cap for its type. */
const MAX_DOWNLOAD_BYTES = chatAttachmentLimit("application/pdf").maxBytes;

/** How long a download may go without receiving any bytes before it is failed, as the viewer fails a stalled load. */
const DOWNLOAD_STALL_MS = 30_000;

/**
 * The response body as a blob, read chunk by chunk: each chunk restarts `restartDeadline`, so a body that stops arriving
 * is aborted by it rather than leaving the download pending.
 */
const readBody = async (response: Response, restartDeadline: () => void): Promise<Blob> => {
    if (!response.body) {
        return await response.blob();
    }

    const chunks: BlobPart[] = [];
    const reader = response.body.getReader();
    let received = 0;

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        received += chunk.value.byteLength;

        // A chat PDF is never larger than its upload cap; a body that keeps coming is not kept in memory.
        if (received > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();

            throw new Error("The PDF is larger than a chat attachment can be.");
        }

        chunks.push(new Uint8Array(chunk.value));
        restartDeadline();
    }

    return new Blob(chunks, { type: response.headers.get("content-type") ?? "application/pdf" });
};

/**
 * The last saved download, one per tab: a new download releases it, so neither repeated clicks nor reopening the panel keeps
 * more than one PDF's bytes alive for the minute each would otherwise be held.
 */
const savedFile: { current: { release: () => void } | null } = { current: null };

/** How long a downloaded PDF's object URL stays valid: long enough for the browser to start the download. */
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

// 32px, and 44px on a touch screen (WCAG 2.5.5 asks for 44px; the controls keep 8px between them).
const ICON_LINK = "hover:bg-accent inline-flex items-center justify-center rounded p-2 pointer-coarse:size-11";

interface PdfPreviewPanelProps {
    className?: string;
    file: PreviewFile;
}

/**
 * A chat PDF in the side panel: its name, download, open in a new tab (the browser prints from there), close, and the
 * viewer's own page and zoom controls.
 */
const PdfPreviewPanel: FC<PdfPreviewPanelProps> = ({ className, file }) => {
    // The file whose download failed: the notice belongs to that file, not to the next one shown.
    const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
    const downloadFailed = failedUrl === file.url;
    const { t } = useLingui();
    const { closeCanvas } = useCanvasState();
    const headingReference = useRef<HTMLHeadingElement>(null);
    const openerReference = useRef<HTMLElement | undefined>(undefined);

    // Each opened file moves focus here, so a keyboard user is not left behind in the thread.
    useEffect(() => {
        openerReference.current = file.opener;
        headingReference.current?.focus();
    }, [file.opener, file.url]);

    // When the panel closes with focus in it, focus goes back to the thumbnail that opened the file on screen, if it is still
    // there. Focus the reader moved elsewhere (a document card that replaced the PDF) stays where it is.
    const rootReference = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const root = rootReference.current;

        return () => {
            const opener = openerReference.current;
            const active = document.activeElement;
            const focusLost = !active || active === document.body || !active.isConnected || root?.contains(active) === true;

            if (focusLost && opener?.isConnected) {
                opener.focus();
            }
        };
    }, []);

    // A download belongs to the document it started for. Showing another document, or closing the panel, abandons it: its fetch is
    // aborted, and a late answer saves nothing, so the reader never gets a PDF they have left.
    const pendingDownload = useRef<AbortController | null>(null);

    useEffect(
        () => () => {
            pendingDownload.current?.abort();
            pendingDownload.current = null;
        },
        [file.url],
    );

    // The link is cross-origin, and a browser opens a cross-origin PDF inline whatever the `download` attribute says.
    // The file is fetched and saved from a local object URL instead.
    const download = async () => {
        const { filename } = file;
        // The message re-signs its attachment URL before the old one expires; the panel may have been open longer than that.
        const url = latestPdfUrl(file.url);

        if (!isFetchableUrl(url, PANEL_ORIGINS)) {
            showError(t`The PDF could not be downloaded.`);

            return;
        }

        pendingDownload.current?.abort();

        const attempt = new AbortController();

        pendingDownload.current = attempt;

        let stalled = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const restartDeadline = () => {
            clearTimeout(deadline);
            deadline = setTimeout(() => {
                // Already left for another file or a closed panel: not a stall to report.
                if (attempt.signal.aborted) {
                    return;
                }

                stalled = true;
                attempt.abort();
            }, DOWNLOAD_STALL_MS);
        };

        restartDeadline();

        try {
            const response = await fetch(url, { signal: attempt.signal });

            if (!response.ok) {
                throw new Error("The PDF could not be fetched.");
            }

            const blob = await readBody(response, restartDeadline);

            if (attempt.signal.aborted) {
                return;
            }

            // One saved file is held at a time: a new download lets the previous one's bytes go, so repeated clicks on a
            // large PDF do not pile up copies for the minute each would otherwise be kept.
            savedFile.current?.release();

            const objectUrl = URL.createObjectURL(blob);
            const link = globalThis.document.createElement("a");

            link.href = objectUrl;
            link.download = filename ?? "document.pdf";
            // Attached while it is clicked: a detached link is ignored by some browsers. The URL outlives the click, so the
            // download can start before it is revoked.
            document.body.appendChild(link);
            link.click();
            link.remove();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const release = () => {
                globalThis.clearTimeout(timer);
                URL.revokeObjectURL(objectUrl);

                if (savedFile.current?.release === release) {
                    savedFile.current = null;
                }
            };

            timer = globalThis.setTimeout(release, DOWNLOAD_URL_LIFETIME_MS);
            savedFile.current = { release };
            setFailedUrl(undefined);
        } catch (error) {
            // Left for another file or a closed panel: nothing to report. A stalled download is a failure to report.
            if (attempt.signal.aborted && !stalled) {
                return;
            }

            console.error("Failed to download the PDF:", error);
            setFailedUrl(file.url);
            showError(t`The PDF could not be downloaded.`);
        } finally {
            clearTimeout(deadline);

            if (pendingDownload.current === attempt) {
                pendingDownload.current = null;
            }
        }
    };

    return (
        <div className={cn("flex h-full min-h-0 flex-col", className)} ref={rootReference}>
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <h2 className="truncate text-sm font-medium" ref={headingReference} tabIndex={-1}>
                    {file.filename ?? t`PDF`}
                </h2>
                <div className="flex shrink-0 items-center gap-2">
                    <button aria-label={t`Download PDF`} className={ICON_LINK} onClick={download} type="button">
                        <Download aria-hidden="true" className="size-4" />
                    </button>
                    {/* Offered only for a URL the page may fetch: the link would send the reader to it. */}
                    {isFetchableUrl(file.url, PANEL_ORIGINS) && (
                        <a
                            aria-label={t`Open PDF in a new tab to print`}
                            className={ICON_LINK}
                            href={file.url}
                            // The newest signed URL, read at the click: the one the panel opened with may have expired.
                            onClick={(event) => {
                                const link = event.currentTarget;

                                link.href = latestPdfUrl(file.url);
                            }}
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            <ExternalLink aria-hidden="true" className="size-4" />
                        </a>
                    )}
                    <button aria-label={t`Close`} className={ICON_LINK} onClick={closeCanvas} type="button">
                        <X aria-hidden="true" className="size-4" />
                    </button>
                </div>
            </div>
            {downloadFailed && (
                <p className="text-destructive px-3 pt-2 text-xs" role="alert">
                    {t`The PDF could not be downloaded.`}
                </p>
            )}
            <div className="flex min-h-0 flex-1 flex-col p-2">
                {/* Keyed by file, so a viewer failure is that file's: the next PDF opened in the panel gets a fresh viewer. The
                    inline alert is the message; no toast on top of it. */}
                <ErrorBoundary
                    fallback={() => (
                        <p className="text-muted-foreground text-sm" role="alert">
                            {t`This preview could not be loaded.`}
                        </p>
                    )}
                    key={file.url}
                    showToast={false}
                >
                    <Suspense fallback={<span className="text-muted-foreground text-sm" role="status">{t`Loading preview…`}</span>}>
                        {/* A new file is a new viewer: the page and zoom of the last one do not carry over. */}
                        <FetchableOriginsProvider origins={PANEL_ORIGINS}>
                            <PdfViewer
                                className="my-0 min-h-0 max-w-none flex-1 rounded-none border-0"
                                filename={file.filename}
                                fill
                                key={file.url}
                                url={file.url}
                            />
                        </FetchableOriginsProvider>
                    </Suspense>
                </ErrorBoundary>
            </div>
        </div>
    );
};

export default PdfPreviewPanel;

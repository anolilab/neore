import { useLingui } from "@lingui/react/macro";
import { FetchableOriginsProvider } from "@neore/ui/components/file-renderers/fetchable-origins-provider";
import { isFetchableUrl, originsOf } from "@neore/ui/hooks/use-fetchable-origins";
import cn from "@neore/ui/utils/cn";
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
    const [downloadFailed, setDownloadFailed] = useState(false);
    const { t } = useLingui();
    const { closeCanvas } = useCanvasState();
    const headingReference = useRef<HTMLHeadingElement>(null);

    // The panel opens from a thumbnail click; focus moves here, so a keyboard user is not left behind in the thread. When the
    // panel closes, focus goes back to the control that opened it, if that is still on the screen.
    useEffect(() => {
        const opener = document.activeElement;

        headingReference.current?.focus();

        return () => {
            if (opener instanceof HTMLElement && opener.isConnected) {
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
        const { filename, url } = file;

        if (!isFetchableUrl(url, PANEL_ORIGINS)) {
            showError(t`The PDF could not be downloaded.`);

            return;
        }

        pendingDownload.current?.abort();

        const attempt = new AbortController();

        pendingDownload.current = attempt;

        try {
            const response = await fetch(url, { signal: attempt.signal });

            if (!response.ok) {
                throw new Error("The PDF could not be fetched.");
            }

            const blob = await response.blob();

            if (attempt.signal.aborted) {
                return;
            }

            const objectUrl = URL.createObjectURL(blob);
            const link = globalThis.document.createElement("a");

            link.href = objectUrl;
            link.download = filename ?? "document.pdf";
            // Attached while it is clicked: a detached link is ignored by some browsers. The URL outlives the click, so the
            // download can start before it is revoked.
            document.body.appendChild(link);
            link.click();
            link.remove();
            globalThis.setTimeout(() => {
                URL.revokeObjectURL(objectUrl);
            }, DOWNLOAD_URL_LIFETIME_MS);
            setDownloadFailed(false);
        } catch (error) {
            if (attempt.signal.aborted) {
                return;
            }

            console.error("Failed to download the PDF:", error);
            setDownloadFailed(true);
            showError(t`The PDF could not be downloaded.`);
        } finally {
            if (pendingDownload.current === attempt) {
                pendingDownload.current = null;
            }
        }
    };

    return (
        <div className={cn("flex h-full min-h-0 flex-col", className)}>
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
                        <a aria-label={t`Open PDF in a new tab to print`} className={ICON_LINK} href={file.url} rel="noopener noreferrer" target="_blank">
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
                <ErrorBoundary
                    fallback={() => (
                        <p className="text-muted-foreground text-sm" role="alert">
                            {t`This preview could not be loaded.`}
                        </p>
                    )}
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

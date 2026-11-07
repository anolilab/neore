import { useLingui } from "@lingui/react/macro";
import { FetchableOriginsProvider } from "@neore/ui/components/file-renderers/fetchable-origins-provider";
import { isFetchableUrl, originsOf } from "@neore/ui/hooks/use-fetchable-origins";
import cn from "@neore/ui/utils/cn";
import { latestPdfUrl } from "@neore/ui/utils/pdf-preview-event";
import { Download, ExternalLink, X } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useEffect, useRef } from "react";

import { ErrorBoundary } from "@/components/error-boundary";
import type { PreviewFile } from "@/features/chat/core/stores/chat-ui-store";
import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";

import usePdfDownload from "./use-pdf-download";

const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));

// The backend serves the signed storage URLs, so its origin is the one the viewer and the download may fetch from.
const PANEL_ORIGINS = originsOf(import.meta.env.VITE_LUNORA_URL as string | undefined);

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
    const { t } = useLingui();
    const { closeCanvas } = useCanvasState();
    const { download, failed: downloadFailed } = usePdfDownload(file, PANEL_ORIGINS);
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

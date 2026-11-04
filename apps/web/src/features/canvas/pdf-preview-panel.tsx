import { useLingui } from "@lingui/react/macro";
import { FetchableOriginsProvider } from "@neore/ui/components/file-renderers/fetchable-origins-provider";
import { isFetchableUrl, originsOf } from "@neore/ui/hooks/use-fetchable-origins";
import cn from "@neore/ui/utils/cn";
import { Download, ExternalLink, X } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import type { PreviewFile } from "@/features/chat/core/stores/chat-ui-store";
import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";
import { showError } from "@/lib/toast";

const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));

// The backend serves the signed storage URLs, so its origin is the one the viewer and the download may fetch from.
const PANEL_ORIGINS = originsOf(import.meta.env.VITE_LUNORA_URL as string | undefined);

/** How long a downloaded PDF's object URL stays valid: long enough for the browser to start the download. */
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

const ICON_LINK = "hover:bg-accent rounded p-2";

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

    // The link is cross-origin, and a browser opens a cross-origin PDF inline whatever the `download` attribute says.
    // The file is fetched and saved from a local object URL instead.
    const download = async () => {
        if (!isFetchableUrl(file.url, PANEL_ORIGINS)) {
            showError(t`The PDF could not be downloaded.`);

            return;
        }

        try {
            const response = await fetch(file.url);

            if (!response.ok) {
                throw new Error("The PDF could not be fetched.");
            }

            const objectUrl = URL.createObjectURL(await response.blob());
            const link = globalThis.document.createElement("a");

            link.href = objectUrl;
            link.download = file.filename ?? "document.pdf";
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
            console.error("Failed to download the PDF:", error);
            setDownloadFailed(true);
            showError(t`The PDF could not be downloaded.`);
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
            </div>
        </div>
    );
};

export default PdfPreviewPanel;

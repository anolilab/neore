import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { Download, ExternalLink, X } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense } from "react";

import type { PreviewFile } from "@/features/chat/core/stores/chat-ui-store";
import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";

const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));

const ICON_LINK = "hover:bg-accent rounded p-1";

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

    return (
        <div className={cn("flex h-full min-h-0 flex-col", className)}>
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <h2 className="truncate text-sm font-medium">{file.filename ?? t`PDF`}</h2>
                <div className="flex shrink-0 items-center gap-1">
                    <a aria-label={t`Download PDF`} className={ICON_LINK} download={file.filename ?? true} href={file.url}>
                        <Download aria-hidden="true" className="size-4" />
                    </a>
                    <a aria-label={t`Open PDF in a new tab to print`} className={ICON_LINK} href={file.url} rel="noopener noreferrer" target="_blank">
                        <ExternalLink aria-hidden="true" className="size-4" />
                    </a>
                    <button aria-label={t`Close`} className={ICON_LINK} onClick={closeCanvas} type="button">
                        <X aria-hidden="true" className="size-4" />
                    </button>
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
                <Suspense fallback={<span className="text-muted-foreground text-sm">{t`Loading preview…`}</span>}>
                    <PdfViewer className="my-0 h-full max-w-none rounded-none border-0" filename={file.filename} url={file.url} />
                </Suspense>
            </div>
        </div>
    );
};

export default PdfPreviewPanel;

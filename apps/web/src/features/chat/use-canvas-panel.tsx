/**
 * The canvas and PDF preview side panel, shared by the single-chat page and the split view: the open-PDF request listener, the
 * blocked-PDF notice, and which chat the panel belongs to. The caller lays the returned content out in its own resizable group.
 */

import { useLingui } from "@lingui/react/macro";
import type { OpenPdfPreviewDetail } from "@neore/ui/utils/pdf-preview-event";
import { OPEN_PDF_PREVIEW_EVENT } from "@neore/ui/utils/pdf-preview-event";
import type { ReactNode } from "react";
import { useEffect } from "react";

import CanvasPanel from "@/features/canvas/canvas-panel";
import PdfPreviewPanel from "@/features/canvas/pdf-preview-panel";
import { isDocumentOpen, useCanvasState, useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { showWarning } from "@/lib/toast";

import useBlockedPdfNoticeLifetime, { BLOCKED_PDF_NOTICE_ID } from "./use-blocked-pdf-notice";

interface CanvasPanelState {
    /** Whether the panel is open for this chat. */
    isPanelOpen: boolean;
    /** The accessible name of the panel region. */
    label: string;
    /** The PDF or canvas to render inside the panel. */
    panel: ReactNode;
}

interface CanvasPanelOptions {
    /**
     * The chat a PDF opened from this request belongs to. The single-chat page answers with its own; the split view answers with
     * the pane the thumbnail sits in, and brings that pane into focus.
     */
    resolveOpenThreadId?: (opener: HTMLElement | undefined) => string | undefined;
}

const useCanvasPanel = (threadId: string | undefined, { resolveOpenThreadId }: CanvasPanelOptions = {}): CanvasPanelState => {
    const { t } = useLingui();
    const { isCanvasOpen, openPreviewFile, previewFile: openedPreview } = useCanvasState();
    // A PDF opened in another thread is not this thread's panel.
    const previewFile = openedPreview?.threadId === threadId ? openedPreview : null;
    // Another thread's PDF is a closed panel here: the canvas does not stand in for it while that preview is cleared.
    const isPanelOpen = isCanvasOpen && (openedPreview === null || previewFile !== null);

    // A chat PDF's thumbnail asks for the side panel; this takes the request (see `packages/ui/src/utils/pdf-preview-event.ts`).
    useEffect(() => {
        const onOpenPdf = (event: Event) => {
            const { detail } = event as CustomEvent<OpenPdfPreviewDetail>;

            // Handled either way, so the thumbnail stays a thumbnail: opening a PDF over a document with unsaved edits would
            // unmount its editor, edits and all. The reader is told why, and can open it once the edits are saved or discarded.
            event.preventDefault();

            // Its editor holds edits that are not saved yet, and nothing reports them, so the panel does not replace it.
            if (isDocumentOpen(useChatUIStore.getState())) {
                // Kept while the document is open: the thumbnail does not change, so a notice that left on its own would leave no reason.
                showWarning(t`Close the open document to view this PDF in the panel.`, { duration: Infinity, id: BLOCKED_PDF_NOTICE_ID });

                return;
            }

            openPreviewFile({
                filename: detail.filename,
                opener: detail.opener,
                threadId: resolveOpenThreadId?.(detail.opener) ?? threadId,
                url: detail.url,
            });
        };

        globalThis.addEventListener(OPEN_PDF_PREVIEW_EVENT, onOpenPdf);

        return () => globalThis.removeEventListener(OPEN_PDF_PREVIEW_EVENT, onOpenPdf);
    }, [openPreviewFile, resolveOpenThreadId, t, threadId]);

    useBlockedPdfNoticeLifetime();

    // A PDF belongs to the thread it was opened in: leaving that thread closes its preview, so it does not come back on return.
    useEffect(
        () => () => {
            const { closeCanvas, previewFile: opened } = useChatUIStore.getState();

            if (opened?.threadId === threadId) {
                closeCanvas();
            }
        },
        [threadId],
    );

    return {
        isPanelOpen,
        label: previewFile ? t`PDF preview` : t`Canvas`,
        panel: previewFile ? <PdfPreviewPanel file={previewFile} /> : <CanvasPanel />,
    };
};

export default useCanvasPanel;

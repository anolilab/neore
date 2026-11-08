import { useEffect } from "react";

import { isDocumentOpen, useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { dismissToast } from "@/lib/toast";

/** The notice that the open document keeps a PDF out of the side panel. */
export const BLOCKED_PDF_NOTICE_ID = "pdf-blocked-by-document";

/** The notice stays until it stops applying: once no document is open (closed, or replaced by the PDF), it goes. */
const useBlockedPdfNoticeLifetime = (): void => {
    const documentOpen = useChatUIStore(isDocumentOpen);

    useEffect(() => {
        if (!documentOpen) {
            dismissToast(BLOCKED_PDF_NOTICE_ID);
        }
    }, [documentOpen]);
};

export default useBlockedPdfNoticeLifetime;

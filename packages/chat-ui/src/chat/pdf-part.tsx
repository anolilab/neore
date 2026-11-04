import { requestPdfPreview } from "@neore/ui/utils/pdf-preview-event";
import type { FC } from "react";
import { lazy, useState } from "react";

const PdfThumbnail = lazy(() => import("@neore/ui/components/file-renderers/pdf-thumbnail"));
const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));

interface PdfPartProps {
    filename?: string;
    url: string;
}

/**
 * A PDF attachment shows its first page. A click asks the app to open the file in its side panel; where no panel
 * listens (a shared view, say) the click shows the inline viewer instead.
 */
const PdfPart: FC<PdfPartProps> = ({ filename, url }) => {
    const [inline, setInline] = useState(false);

    if (inline) {
        return <PdfViewer filename={filename} url={url} />;
    }

    const open = () => {
        if (!requestPdfPreview({ filename, url })) {
            setInline(true);
        }
    };

    // A new URL is a new attachment: its thumbnail starts over rather than keeping a failure or page count.
    return <PdfThumbnail filename={filename} key={url} onOpen={open} url={url} />;
};

export default PdfPart;

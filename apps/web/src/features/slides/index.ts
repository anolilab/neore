/**
 * Slides feature - Presentation creation and viewing
 * Ported from kortix-ai/suna presentation system
 *
 * ## Architecture
 *
 * - **Backend**: Lunora tables `presentations` and `presentationSlides`
 *   with cRPC mutations in `backend/lunora/chat/slides/functions.ts`
 *
 * - **Frontend**: React components for viewing/previewing slides stored as
 *   HTML in Lunora. Slides are 1920x1080 HTML documents rendered in
 *   scaled iframes.
 *
 * - **Styles**: 40+ pre-configured presentation themes with fonts, colors,
 *   and design characteristics.
 *
 * ## Usage
 *
 * ```tsx
 * import { PresentationViewer, PRESENTATION_STYLES } from "@/features/slides";
 *
 * &lt;PresentationViewer
 *   presentationId={id}
 *   presentationTitle="Q4 Report"
 *   slides={slidesData}
 * />
 * ```
 */

// Components
export {
    FullScreenPresentationViewer,
    PresentationArtifact,
    PresentationSlideCard,
    PresentationSlideSkeleton,
    PresentationViewer,
    PresentationViewerRoot,
    SlideEditorDialog,
} from "./components";

// Hooks
export { useGeneratingPresentation, usePresentationData, usePresentationViewerStore } from "./hooks";

// Library / utilities
export {
    buildSlideIframeHtml,
    calculateSlideScale,
    createSlideDataUrl,
    createSlideHtml,
    createStreamingSlideHtml,
    downloadPresentation,
    getAllStyles,
    getStyleConfig,
    getStyleNames,
    PRESENTATION_STYLES,
    revokeSlideDataUrl,
    sanitizePresentationName,
    SLIDE_HEIGHT,
    SLIDE_WIDTH,
} from "./lib";

// Types
export type {
    DownloadFormat,
    PresentationExport,
    PresentationMetadata,
    PresentationStyleConfig,
    PresentationViewerState,
    SlideContent,
    SlideMetadata,
} from "./types";

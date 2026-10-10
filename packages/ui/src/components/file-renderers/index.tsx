export { type FileRendererType, formatFileSize, getFileRendererType, isAudio, isDocx, isImage, isPdf, isVideo } from "./file-type-utilities";
export { default as GenericFileCard, type GenericFileCardProps } from "./generic-file-card";

/**
 * Heavy renderers are NOT exported from this barrel to keep them code-split.
 * Import them directly via lazy loading:
 *
 * ```tsx
 * const PdfViewer = lazy(() => import("@neore/ui/components/file-renderers/pdf-viewer"));
 * const VideoPlayer = lazy(() => import("@neore/ui/components/file-renderers/video-player"));
 * const AudioWaveformPlayer = lazy(() => import("@neore/ui/components/file-renderers/audio-waveform-player"));
 * const DocxPreview = lazy(() => import("@neore/ui/components/file-renderers/docx-preview"));
 * const JsonViewer = lazy(() => import("@neore/ui/components/file-renderers/json-viewer"));
 * const HexViewer = lazy(() => import("@neore/ui/components/file-renderers/hex-viewer"));
 * const PptxPreview = lazy(() => import("@neore/ui/components/file-renderers/pptx-preview"));
 * ```
 */

export type { HexViewerProps } from "./hex-viewer";
export type { JsonViewerProps } from "./json-viewer";
export type { PptxPreviewProps } from "./pptx-preview";

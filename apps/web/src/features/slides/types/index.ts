/**
 * Slides feature types
 * Ported from kortix-ai/suna presentation system
 */

export interface SlideMetadata {
    createdAt: string;
    filename: string;
    htmlContent: string;
    title: string;
    updatedAt?: string;
}

export interface PresentationMetadata {
    createdAt: string;
    description: string;
    presentationName: string;
    slides: Record<string, SlideMetadata>;
    title: string;
    updatedAt: string;
}

export interface PresentationStyleConfig {
    accentColor: string;
    background: string;
    characteristics: string[];
    description: string;
    font: string;
    fontFamily: string;
    fontImport: string;
    name: string;
    primaryColor: string;
    textColor: string;
}

export interface SlideContent {
    htmlContent: string;
    slideNumber: number;
    slideTitle: string;
}

export interface PresentationExport {
    blob: Blob;
    filename: string;
    format: "pdf" | "pptx";
}

export type DownloadFormat = "pdf" | "pptx";

export interface PresentationViewerState {
    closePresentation: () => void;
    initialSlide?: number;
    isOpen: boolean;
    openPresentation: (presentationId: string, initialSlide?: number) => void;
    presentationId?: string;
}

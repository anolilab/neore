/**
 * Presentation utility functions
 * Ported from kortix-ai/suna presentation-utils.ts
 * Adapted for Lunora-backed slide storage instead of sandbox filesystem.
 *
 * Export uses pptxgenjs (PPTX) and html2canvas + jsPDF (PDF)
 * to produce downloads entirely in the browser.
 */

import type { DownloadFormat } from "../types";
import { createSlideHtml, SLIDE_HEIGHT, SLIDE_WIDTH } from "./slide-html-template";

/**
 * Builds a complete standalone HTML string for a slide
 * that can be rendered via iframe srcDoc.
 */
export const buildSlideIframeHtml = (htmlContent: string, slideNumber: number, totalSlides: number, presentationTitle: string): string =>
    createSlideHtml(htmlContent, slideNumber, totalSlides, presentationTitle);

/**
 * Generates a data-URI or blob URL for a slide's HTML so it can be
 * used as an iframe `src` attribute.
 */
export const createSlideDataUrl = (html: string): string => {
    const blob = new Blob([html], { type: "text/html" });

    return URL.createObjectURL(blob);
};

/**
 * Revokes a previously created blob URL to free memory.
 */
export const revokeSlideDataUrl = (url: string): void => {
    try {
        URL.revokeObjectURL(url);
    } catch {
        // noop – URL may already be revoked
    }
};

/**
 * Calculates the CSS transform scale to fit a 1920x1080 slide
 * into the given container dimensions while maintaining aspect ratio.
 */
export const calculateSlideScale = (containerWidth: number, containerHeight: number): number => {
    const scaleX = containerWidth / SLIDE_WIDTH;
    const scaleY = containerHeight / SLIDE_HEIGHT;

    return Math.min(scaleX, scaleY);
};

// ---------------------------------------------------------------------------
// Slide-to-canvas rendering (shared by PPTX & PDF export)
// ---------------------------------------------------------------------------

/**
 * Renders a single slide's HTML content into an off-screen iframe,
 * captures it with html2canvas, and returns the canvas.
 */
const renderSlideToCanvas = async (htmlContent: string, slideNumber: number, totalSlides: number, presentationTitle: string): Promise<HTMLCanvasElement> => {
    const html2canvasModule = await import("html2canvas");
    const html2canvas = html2canvasModule.default;

    const slideHtml = createSlideHtml(htmlContent, slideNumber, totalSlides, presentationTitle);

    // Create an offscreen iframe to render the slide at native 1920x1080
    const iframe = document.createElement("iframe");

    iframe.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;border:none;visibility:hidden;`;
    // `appendChild`, not `append`: the workers-types `Element.append(content, options)`
    // declaration shadows the DOM `ParentNode.append(...nodes)` overload in this project.
    document.body.appendChild(iframe);

    try {
        const iframeDocument = iframe.contentDocument ?? iframe.contentWindow?.document;

        if (!iframeDocument) {
            throw new Error("Could not access iframe document");
        }

        iframeDocument.open();
        iframeDocument.write(slideHtml);
        iframeDocument.close();

        // Wait for fonts & images to settle
        await new Promise<void>((resolve) => {
            const onLoad = () => resolve();

            if (iframeDocument.readyState === "complete") {
                // Give an extra tick for fonts
                setTimeout(onLoad, 500);
            } else {
                iframe.addEventListener("load", () => setTimeout(onLoad, 500));
            }
        });

        const canvas = await html2canvas(iframeDocument.body, {
            allowTaint: true,
            height: SLIDE_HEIGHT,
            logging: false,
            scale: 1,
            useCORS: true,
            width: SLIDE_WIDTH,
        });

        return canvas;
    } finally {
        iframe.remove();
    }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sanitizeFileName = (name: string): string => name.replaceAll(/[^\w\s-]/g, "").trim() || "presentation";

// ---------------------------------------------------------------------------
// PPTX export via pptxgenjs
// ---------------------------------------------------------------------------

const exportPptx = async (presentationTitle: string, slides: { htmlContent: string; title: string }[]): Promise<void> => {
    const pptxModule = await import("pptxgenjs");
    const PptxGenJS = pptxModule.default;
    const pptx = new PptxGenJS();

    pptx.layout = "LAYOUT_WIDE"; // 13.33" x 7.5" — standard 16:9
    pptx.title = presentationTitle;
    pptx.author = "Neore Chat";

    // Render all slides to canvases (sequentially to avoid memory pressure)
    for (let i = 0; i < slides.length; i += 1) {
        const slide = slides[i];

        if (!slide) {
            continue;
        }

        const canvas = await renderSlideToCanvas(slide.htmlContent, i + 1, slides.length, presentationTitle);

        const imgData = canvas.toDataURL("image/png");
        const pptxSlide = pptx.addSlide();

        pptxSlide.addImage({
            data: imgData,
            h: "100%",
            w: "100%",
            x: 0,
            y: 0,
        });
    }

    await pptx.writeFile({ fileName: `${sanitizeFileName(presentationTitle)}.pptx` });
};

// ---------------------------------------------------------------------------
// PDF export via html2canvas + jsPDF
// ---------------------------------------------------------------------------

const exportPdf = async (presentationTitle: string, slides: { htmlContent: string; title: string }[]): Promise<void> => {
    const { jsPDF: JsPdf } = await import("jspdf");

    // PDF in landscape, dimensions matching 16:9 (in mm)
    // 1920x1080 at 96dpi ≈ 508mm x 285.75mm. We use standard A4-landscape-ish sizing.
    const pdfWidthMm = 338.67; // ~13.33 inches
    const pdfHeightMm = 190.5; // ~7.5 inches
    const pdf = new JsPdf({
        format: [pdfWidthMm, pdfHeightMm],
        orientation: "landscape",
        unit: "mm",
    });

    for (let i = 0; i < slides.length; i += 1) {
        if (i > 0) {
            pdf.addPage([pdfWidthMm, pdfHeightMm], "landscape");
        }

        const slide = slides[i];

        if (!slide) {
            continue;
        }

        const canvas = await renderSlideToCanvas(slide.htmlContent, i + 1, slides.length, presentationTitle);

        const imgData = canvas.toDataURL("image/png");

        pdf.addImage(imgData, "PNG", 0, 0, pdfWidthMm, pdfHeightMm);
    }

    pdf.save(`${sanitizeFileName(presentationTitle)}.pdf`);
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Triggers browser download of a presentation as PPTX or PDF.
 * Renders each slide via html2canvas, then assembles with pptxgenjs / jsPDF.
 */
export const downloadPresentation = async (
    format: DownloadFormat,
    presentationTitle: string,
    slides: { htmlContent: string; title: string }[],
): Promise<void> => {
    if (slides.length === 0) {
        throw new Error("No slides to export");
    }

    switch (format) {
        case "pdf": {
            await exportPdf(presentationTitle, slides);
            break;
        }
        case "pptx": {
            await exportPptx(presentationTitle, slides);
            break;
        }
        default: {
            const exhaustive: never = format;

            throw new Error(`Unsupported format: ${exhaustive}`);
        }
    }
};

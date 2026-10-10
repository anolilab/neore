/**
 * Slide HTML template engine
 * Ported from kortix-ai/suna SandboxPresentationTool._create_slide_html
 *
 * Generates standalone HTML documents for each slide at 1920x1080 (16:9).
 * Slides are rendered in iframes with responsive scaling.
 */

import type { PresentationStyleConfig } from "../types";

/** Slide dimensions (16:9 aspect ratio) */
export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

const escapeHtml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

/**
 * Creates a complete HTML document for a single slide.
 * @param content HTML body content (no doctype/html/head/body tags)
 * @param slideNumber 1-based slide number
 * @param _totalSlides Unused — kept so callers can pass the deck length positionally
 * @param presentationTitle Deck name, escaped into the document <title> tag
 * @param style Optional style config for custom fonts/themes
 */
export const createSlideHtml = (
    content: string,
    slideNumber: number,
    _totalSlides: number,
    presentationTitle: string,
    style?: PresentationStyleConfig,
): string => {
    const fontImport = style?.fontImport ?? "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap";

    const fontFamily = style?.fontFamily ?? "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=${SLIDE_WIDTH}, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
    <title>${escapeHtml(presentationTitle)} - Slide ${slideNumber}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="${fontImport}" rel="stylesheet">
    <style>
        * {
            font-family: ${fontFamily};
        }
        body {
            height: ${SLIDE_HEIGHT}px;
            width: ${SLIDE_WIDTH}px;
            margin: 0;
            padding: 0;
            font-family: ${fontFamily};
        }
    </style>
</head>
<body>
    ${content}
</body>
</html>`;
};

/**
 * Creates a minimal HTML document for streaming slide preview.
 * Used by PresentationSlideSkeleton to render content as it streams in.
 */
export const createStreamingSlideHtml = (content: string): string => `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: ${SLIDE_WIDTH}px;
      height: ${SLIDE_HEIGHT}px;
      overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
    }
    body { padding: 60px; }
  </style>
</head>
<body>
${content}
</body>
</html>`;

/**
 * Sanitize a presentation name to a safe directory/filename string.
 * Matches the backend sanitisation logic from Suna.
 */
export const sanitizePresentationName = (name: string): string => name.replaceAll(/[^\w-]/g, "").toLowerCase();

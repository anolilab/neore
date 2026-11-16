/**
 * Clipboard HTML → Markdown for the composer: the `@neore/html-to-markdown` paste preset. Loaded with `import()` only
 * when a paste carries HTML.
 *
 * The HTML is untrusted: the converter parses it into an inert document (no scripts run, nothing loads), reads only its
 * text, and the result goes into the editor as text, never as HTML. HTML nested too deep, or past the converter's work
 * budgets, throws a RangeError, and the paste goes in as copied.
 */
import TurndownService, { paste, PASTE_OPTIONS } from "@neore/html-to-markdown";

export { visibleText } from "./visible-text";

/** The Markdown for a clipboard `text/html` payload; empty when it holds no text. */
export const htmlToMarkdown = (html: string): string => new TurndownService(PASTE_OPTIONS).use(paste).turndown(html);

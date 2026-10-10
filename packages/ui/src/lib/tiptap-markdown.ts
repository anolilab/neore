/**
 * Markdown ↔ TipTap JSON round-trip conversion.
 *
 * Uses the unified ecosystem (remark/rehype) to convert between markdown
 * and HTML, then TipTap's generateJSON / getHTML() for the HTML ↔ JSON bridge.
 *
 * Flow:
 *   Markdown → (remark) → HTML → (TipTap) → JSON
 *   JSON → (TipTap) → HTML → (rehype→remark) → Markdown
 */
import type { Extensions, JSONContent } from "@tiptap/core";
import { generateHTML, generateJSON } from "@tiptap/core";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

/**
 * Convert a markdown string to HTML.
 */
const htmlFromMarkdown = (markdown: string): string =>
    unified().use(remarkParse).use(remarkGfm).use(remarkHtml, { sanitize: false }).processSync(markdown).toString();

/**
 * Convert an HTML string to markdown.
 */
const markdownFromHTML = (html: string): string =>
    unified().use(rehypeParse).use(rehypeRemark).use(remarkGfm).use(remarkStringify).processSync(html).toString();

/**
 * Convert markdown to TipTap JSON.
 * Requires the TipTap extensions array to parse the HTML into the correct node types.
 */
export const markdownToTiptapJSON = (extensions: Extensions, markdown: string): JSONContent => {
    const html = htmlFromMarkdown(markdown);

    return generateJSON(html, extensions);
};

/**
 * Convert TipTap JSON to markdown.
 * Requires the TipTap extensions array to generate the HTML from JSON.
 */
export const tiptapJSONToMarkdown = (extensions: Extensions, json: JSONContent): string => {
    const html = generateHTML(json, extensions);

    return markdownFromHTML(html);
};

/**
 * Convert HTML to markdown.
 * Useful when you already have HTML from editor.getHTML().
 */
export const htmlToMarkdown = (html: string): string => markdownFromHTML(html);

/**
 * Convert markdown to HTML.
 * Useful for rendering markdown content.
 */
export const markdownToHTML = (markdown: string): string => htmlFromMarkdown(markdown);

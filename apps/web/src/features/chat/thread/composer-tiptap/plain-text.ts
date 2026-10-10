/** Plain composer text → tiptap paragraph HTML (one `<p>` per line, escaped). */

const escapeHtml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export const plainTextToHtml = (text: string): string =>
    text
        .split("\n")
        .map((line) => `<p>${line ? escapeHtml(line) : "<br>"}</p>`)
        .join("");

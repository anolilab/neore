import { createDocument } from "@mixmark-io/domino";

/**
 * Parses an HTML string into an inert document.
 *
 * Browsers use the native DOMParser, which never loads images, frames or
 * scripts. Without one (Node, tests) this falls back to domino.
 * TEMPORARY: domino is dropped in the IR rewrite (see README, "Roadmap").
 */
export function parseHTML(html: string): Document {
    if (typeof DOMParser === "function") {
        return new DOMParser().parseFromString(html, "text/html");
    }

    return createDocument(html);
}

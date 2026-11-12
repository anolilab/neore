import collapseWhitespace from "./collapse-whitespace";
import { parseHTML } from "./html-parser";
import type { Options } from "./types";
import { isBlock, isVoid } from "./utilities";

/**
 * Builds the element the conversion walks: a parsed copy of an HTML string,
 * or a deep clone of a DOM node. Whitespace is collapsed before any rule runs.
 */
export default function rootNode(input: string | Node, options: Options): Node {
    let root: Node;

    if (typeof input === "string") {
        // DOM parsers arrange elements in the <head> and <body>.
        // Wrapping in a custom element ensures elements are reliably arranged in
        // a single element. The wrapper is left open: the parser closes it at the
        // end of the input. A closing tag would be read as text when the input ends
        // inside a raw-text element such as <textarea>. The wrapper's name is random
        // for each call, so input text cannot write a tag that would end it early.
        const token = randomToken();
        const htmlDocument = parseHTML(`<x-turndown-${token} id="turndown-root-${token}">${input}`);

        root = htmlDocument.querySelector(`#turndown-root-${token}`) as Node;
    } else {
        root = input.cloneNode(true);
    }

    removeNonContent(root);

    collapseWhitespace({
        element: root,
        isBlock,
        isPre: options.preformattedCode ? isPreOrCode : null,
        isVoid,
    });

    return root;
}

/**
 * Elements whose text is never content: a script or style sheet, a noscript fallback, a template, a title. Removed with
 * their text, before whitespace is collapsed, so the text around them keeps its spacing. Matched by local name, in any
 * namespace, so an SVG `<script>` or `<style>` is removed too.
 */
const NON_CONTENT_NAMES = new Set(["noscript", "script", "style", "template", "title"]);
const NON_CONTENT_SELECTOR = [...NON_CONTENT_NAMES].join(", ");

/** Removes the non-content elements under `root`. A root that is itself one of them is emptied. */
function removeNonContent(root: Node): void {
    if (root.nodeType === 1 && NON_CONTENT_NAMES.has((root as Element).localName)) {
        while (root.firstChild) {
            root.firstChild.remove();
        }

        return;
    }

    for (const element of (root as ParentNode).querySelectorAll(NON_CONTENT_SELECTOR)) {
        element.remove();
    }
}

function isPreOrCode(node: Node): boolean {
    return node.nodeName === "PRE" || node.nodeName === "CODE";
}

/**
 * Returns 96 random bits as hex. getRandomValues, not randomUUID: the latter
 * is missing outside secure contexts.
 */
function randomToken(): string {
    const bytes = new Uint8Array(12);

    // The global Web Crypto exists from Node 19; the plugin's data says 23.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    crypto.getRandomValues(bytes);

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

    collapseWhitespace({
        element: root,
        isBlock,
        isPre: options.preformattedCode ? isPreOrCode : null,
        isVoid,
    });

    return root;
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

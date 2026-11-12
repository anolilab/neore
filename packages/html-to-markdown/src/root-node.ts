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
        // a single element.
        const htmlDocument = parseHTML(`<x-turndown id="turndown-root">${input}</x-turndown>`);

        root = htmlDocument.querySelector("#turndown-root") as Node;
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

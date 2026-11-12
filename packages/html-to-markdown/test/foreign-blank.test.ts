import { createDocument } from "@mixmark-io/domino";
import TurndownUpstream from "turndown";
import { describe, expect, it } from "vitest";

import TurndownService from "../src/index";

/*
 * Blankness looks for void and meaningful-when-blank descendants. Foreign elements
 * (inside SVG or MathML) keep their own case, so an upper-case selector does not
 * match them. Elements built with a prefix (createElementNS) match by local name.
 * Each case must give upstream's answer.
 */
const HTML_CASES = [
    "<span> <svg><a></a></svg></span>",
    "<span> <svg><script></script></svg></span>",
    "<p> <svg><a href=x></a></svg> </p>",
    "<div> <math><a></a></math></div>",
    "<span> <svg><g><br></g></svg></span>",
    "<span> <svg><text>t</text></svg></span>",
    "<td> <svg><A></A></svg></td>",
    "<span><svg></svg></span>",
    "<div> <img src=i.png> </div>",
    "<div> <span> <svg> <g> <a></a> </g> </svg> </span> </div>",
];

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** A paragraph and a list with blank elements, plus one prefixed element added to each blank one. */
function documentWithPrefixedElement(prefixedName: string): Node {
    const document = createDocument("<p>a<span> </span>b</p><ul><li>x</li><li></li></ul>");
    const span = document.querySelector("span");
    const emptyItem = document.querySelectorAll("li")[1];

    // domino has no ChildNode.append, so appendChild is the only option here.
    // eslint-disable-next-line unicorn/prefer-dom-node-append
    span?.appendChild(document.createElementNS(XHTML_NAMESPACE, prefixedName));
    // eslint-disable-next-line unicorn/prefer-dom-node-append
    emptyItem?.appendChild(document.createElementNS(XHTML_NAMESPACE, prefixedName));

    return document.body;
}

const PREFIXED_NAMES = ["x:a", "x:img", "x:script", "x:br", "x:td"];

describe("blank detection with foreign elements", () => {
    const upstream = new TurndownUpstream();

    it.each(HTML_CASES)("matches upstream for %j", (input) => {
        expect(new TurndownService().turndown(input)).toBe(upstream.turndown(input));
    });
});

describe("blank detection with prefixed elements added as DOM nodes", () => {
    const upstream = new TurndownUpstream();

    it.each(PREFIXED_NAMES)("matches upstream when %j is added", (prefixedName) => {
        const input = documentWithPrefixedElement(prefixedName);

        expect(new TurndownService().turndown(input)).toBe(upstream.turndown(input));
    });
});

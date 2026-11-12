import type { AnnotatedNode, Options } from "./types";
import { hasMeaningfulWhenBlank, hasVoid, isBlock, isMeaningfulWhenBlank, isVoid } from "./utilities";

const BLANK = /^\s*$/;
const SPACE_CHAR = /\s/;
const LEFT_SPACE = / $/;
const RIGHT_SPACE = /^ /;

export interface Edges {
    leading: string;
    leadingAscii: string;
    leadingNonAscii: string;
    trailing: string;
    trailingAscii: string;
    trailingNonAscii: string;
}

/**
 * Annotates a DOM node in place with the facts the rules read. Upstream mutates
 * the DOM this way; the IR rewrite replaces it.
 */
export default function annotateNode(node: Node, options: Options): AnnotatedNode {
    const annotated = node as AnnotatedNode;

    annotated.isBlock = isBlock(node);
    annotated.isCode = node.nodeName === "CODE" || Boolean((node.parentNode as AnnotatedNode | null)?.isCode);
    annotated.isBlank = isBlank(node);
    annotated.flankingWhitespace = flankingWhitespace(annotated, options);

    return annotated;
}

function isBlank(node: Node): boolean {
    return !isVoid(node) && !isMeaningfulWhenBlank(node) && BLANK.test(node.textContent ?? "") && !hasVoid(node) && !hasMeaningfulWhenBlank(node);
}

function flankingWhitespace(node: AnnotatedNode, options: Options): { leading: string; trailing: string } {
    if (node.isBlock || (options.preformattedCode && node.isCode)) {
        return { leading: "", trailing: "" };
    }

    const edges = edgeWhitespace(node.textContent ?? "");

    // abandon leading ASCII WS if left-flanked by ASCII WS
    if (edges.leadingAscii && isFlankedByWhitespace("left", node, options)) {
        edges.leading = edges.leadingNonAscii;
    }

    // abandon trailing ASCII WS if right-flanked by ASCII WS
    if (edges.trailingAscii && isFlankedByWhitespace("right", node, options)) {
        edges.trailing = edges.trailingNonAscii;
    }

    return { leading: edges.leading, trailing: edges.trailing };
}

function isAsciiSpace(char: string): boolean {
    return [" ", "\t", "\r", "\n"].includes(char);
}

/**
 * Splits a string's outer whitespace into ASCII and non-ASCII parts.
 *
 * Same result as upstream's regular expression, but a single linear scan:
 * the regular expression backtracks super-linearly on long runs of spaces.
 * A whitespace-only string is all leading; an empty string has no edges.
 */
export function edgeWhitespace(string: string): Edges {
    const { length } = string;
    let start = 0;

    while (start < length && SPACE_CHAR.test(string[start] ?? "")) {
        start += 1;
    }

    let leadingAsciiEnd = 0;

    while (leadingAsciiEnd < start && isAsciiSpace(string[leadingAsciiEnd] ?? "")) {
        leadingAsciiEnd += 1;
    }

    if (start === length) {
        // whitespace-only (or empty): everything is leading
        return {
            leading: string,
            leadingAscii: string.slice(0, leadingAsciiEnd),
            leadingNonAscii: string.slice(leadingAsciiEnd),
            trailing: "",
            trailingAscii: "",
            trailingNonAscii: "",
        };
    }

    let end = length;

    while (end > start && SPACE_CHAR.test(string[end - 1] ?? "")) {
        end -= 1;
    }

    let trailingAsciiStart = length;

    while (trailingAsciiStart > end && isAsciiSpace(string[trailingAsciiStart - 1] ?? "")) {
        trailingAsciiStart -= 1;
    }

    return {
        leading: string.slice(0, start),
        leadingAscii: string.slice(0, leadingAsciiEnd),
        leadingNonAscii: string.slice(leadingAsciiEnd, start),
        trailing: string.slice(end),
        trailingAscii: string.slice(trailingAsciiStart),
        trailingNonAscii: string.slice(end, trailingAsciiStart),
    };
}

function isFlankedByWhitespace(side: "left" | "right", node: AnnotatedNode, options: Options): boolean {
    const sibling = side === "left" ? node.previousSibling : node.nextSibling;

    if (!sibling) {
        return false;
    }

    const pattern = side === "left" ? LEFT_SPACE : RIGHT_SPACE;

    if (sibling.nodeType === 3) {
        return pattern.test(sibling.nodeValue ?? "");
    }

    if (options.preformattedCode && sibling.nodeName === "CODE") {
        return false;
    }

    if (sibling.nodeType === 1 && !isBlock(sibling)) {
        return pattern.test(sibling.textContent ?? "");
    }

    return false;
}

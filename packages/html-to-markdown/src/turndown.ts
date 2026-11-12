import COMMONMARK_RULES from "./commonmark-rules";
import annotateNode from "./node";
import rootNode from "./root-node";
import Rules from "./rules";
import type { AnnotatedNode, Options, Rule } from "./types";
import {
    escapeMarkdown,
    isBlock,
    trimKeepingBreaks,
    trimLeadingBreaks,
    trimLeadingNewlines,
    trimTrailingNewlines,
} from "./utilities";

export type TurndownInput = string | Node;

export const DEFAULT_OPTIONS: Options = {
    blankReplacement(_content, node) {
        return node.isBlock ? "\n\n" : "";
    },
    br: "  ",
    bulletListMarker: "*",
    codeBlockStyle: "indented",
    defaultReplacement(content, node) {
        return node.isBlock ? `\n\n${content}\n\n` : content;
    },
    emDelimiter: "_",
    fence: "```",
    headingStyle: "setext",
    hr: "* * *",
    keepReplacement(_content, node) {
        return node.isBlock ? `\n\n${node.outerHTML}\n\n` : node.outerHTML;
    },
    linkReferenceStyle: "full",
    linkStyle: "inlined",
    preformattedCode: false,
    rules: COMMONMARK_RULES,
    safeLinks: false,
    strongDelimiter: "**",
};

export default class TurndownService {
    readonly options: Options;

    readonly rules: Rules;

    /**
     * Escapes Markdown syntax in text. A property, not a method, so that
     * `process` can call it without a receiver.
     */
    escape: (string: string) => string;

    constructor(options?: Partial<Options>) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.rules = new Rules(this.options);
        this.escape = escapeMarkdown;
    }

    /**
     * Converts a string or DOM node to Markdown.
     */
    turndown(input: TurndownInput): string {
        if (!canConvert(input)) {
            throw new TypeError(`${describeInput(input)} is not a string, or an element/document/fragment node.`);
        }

        if (input === "") {
            return "";
        }

        const output = process(this, rootNode(input, this.options));

        return postProcess(this, output);
    }

    /**
     * Adds one or more plugins. A plugin is called with the service instance.
     */
    use(plugin: ((service: TurndownService) => void) | ((service: TurndownService) => void)[]): this {
        if (Array.isArray(plugin)) {
            for (const item of plugin) {
                this.use(item);
            }
        } else if (typeof plugin === "function") {
            plugin(this);
        } else {
            throw new TypeError("plugin must be a Function or an Array of Functions");
        }

        return this;
    }

    addRule(key: string, rule: Rule): this {
        this.rules.add(key, rule);

        return this;
    }

    keep(filter: Rule["filter"]): this {
        this.rules.keep(filter);

        return this;
    }

    remove(filter: Rule["filter"]): this {
        this.rules.remove(filter);

        return this;
    }
}

/**
 * Reduces a DOM node down to its Markdown string equivalent.
 */
function process(service: TurndownService, parentNode: Node): string[] {
    const output: string[] = [];

    for (const child of parentNode.childNodes) {
        const node = annotateNode(child, service.options);

        let replacement = "";

        // Node.TEXT_NODE or Node.CDATA_SECTION_NODE: collapseWhitespace keeps both.
        if (node.nodeType === 3 || node.nodeType === 4) {
            const text = node.nodeValue ?? "";

            replacement = node.isCode ? text : escapeText(service, child, text);
        } else if (node.nodeType === 1) {
            replacement = replacementForNode(service, node);
        }

        join(output, replacement);
    }

    return output;
}

// The characters after `<` that open raw HTML or an autolink.
const HTML_OPENER = /^[a-z/!?]/i;

/**
 * Escapes a text node. `escapeMarkdown` sees only this node, so a `<` at its end is
 * left alone there. Here the next output is known from the DOM: a `<` is escaped when
 * that output may begin with one of the characters that open raw HTML or an autolink.
 * A `<` followed by a space, a line break or the end of its block stays as it is.
 */
function escapeText(service: TurndownService, node: Node, text: string): string {
    const escaped = service.escape(text);

    if (text.endsWith("<") && escaped.endsWith("<") && isFollowedByHtmlOpener(node)) {
        return `${escaped.slice(0, -1)}${String.raw`\<`}`;
    }

    return escaped;
}

/**
 * True when the output after the node may begin with a character that opens raw HTML.
 * It looks at the next sibling, then past the end of an inline parent. A link or a
 * block ends the search: a link closes with `]`, and a block starts on a new line.
 * A sibling whose text is blank may print nothing, so it is looked past too. The
 * check is conservative: a `<` that cannot open HTML may still be escaped.
 */
function isFollowedByHtmlOpener(node: Node): boolean {
    let current: Node | null = node;

    while (current) {
        for (let sibling = current.nextSibling; sibling; sibling = sibling.nextSibling) {
            const text = sibling.nodeType === 8 ? "" : (sibling.textContent ?? "").trimStart();

            if (text) {
                return HTML_OPENER.test(text);
            }
        }

        const parent: Node | null = current.parentNode;

        if (!parent || parent.nodeName === "A" || isBlock(parent)) {
            return false;
        }

        current = parent;
    }

    return false;
}

/**
 * Appends strings as each rule requires and trims the output.
 */
function postProcess(service: TurndownService, output: string[]): string {
    service.rules.forEach((rule) => {
        if (typeof rule.append === "function") {
            join(output, rule.append(service.options));
        }
    });

    // trimEnd removes the same characters as the regular expression it replaces, linearly.
    return trimLeadingBreaks(output.join("")).trimEnd();
}

/**
 * Converts an element node to its Markdown equivalent.
 */
function replacementForNode(service: TurndownService, node: AnnotatedNode): string {
    const rule = service.rules.forNode(node);
    let content = process(service, node).join("");
    const whitespace = node.flankingWhitespace;

    if (whitespace.leading || whitespace.trailing) {
        // Inline code keeps upstream's plain trim. Elsewhere a plain trim would also remove a hard
        // line break at either end of the content.
        content = node.nodeName === "CODE" ? content.trim() : trimKeepingBreaks(content, node, service.options.br);
    }

    return whitespace.leading + rule.replacement(content, node, service.options, service.rules) + whitespace.trailing;
}

/**
 * Joins a replacement onto the output accumulator using the appropriate number
 * of new lines. Only the last array element keeps trailing whitespace.
 */
function join(output: string[], replacement: string): void {
    const tail = output.pop() ?? "";
    const s1 = trimTrailingNewlines(tail);
    const s2 = trimLeadingNewlines(replacement);
    const nls = Math.max(tail.length - s1.length, replacement.length - s2.length);
    const separator = "\n\n".slice(0, nls);

    if (s1) {
        output.push(s1);
    }

    if (separator) {
        output.push(separator);
    }

    if (s2) {
        output.push(s2);
    }
}

/**
 * Names an invalid input for the error message. String() throws on an object
 * with no prototype, so objects get their tag instead.
 */
function describeInput(input: unknown): string {
    return typeof input === "object" && input !== null ? Object.prototype.toString.call(input) : String(input);
}

function canConvert(input: unknown): input is TurndownInput {
    if (input == null) {
        return false;
    }

    if (typeof input === "string") {
        return true;
    }

    // An object with a nodeType alone is not a node: rootNode calls cloneNode.
    const node = input as Partial<Node>;

    return [1, 9, 11].includes(node.nodeType as number) && typeof node.cloneNode === "function";
}

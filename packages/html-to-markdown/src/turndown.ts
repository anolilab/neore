import COMMONMARK_RULES, { isRenderedLink } from "./commonmark-rules";
import annotateNode from "./node";
import rootNode from "./root-node";
import Rules, { defaultKeepReplacement } from "./rules";
import type { AnnotatedNode, Options, Rule, RuleLookup } from "./types";
import {
    defaultBlankReplacement,
    defaultElementReplacement,
    escapeMarkdown,
    isBlock,
    removeReplacement,
    trimKeepingBreaks,
    trimLeadingBreaks,
    trimLeadingNewlines,
    trimTrailingNewlines,
} from "./utilities";

export type TurndownInput = string | Node;

export const DEFAULT_OPTIONS: Options = {
    blankReplacement: defaultBlankReplacement,
    br: "  ",
    bulletListMarker: "*",
    codeBlockStyle: "indented",
    defaultReplacement: defaultElementReplacement,
    emDelimiter: "_",
    fence: "```",
    headingStyle: "setext",
    hr: "* * *",
    keepReplacement: defaultKeepReplacement,
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

// The character that opens raw HTML after a `<`, and a character of an email local part. An email
// autolink opens with a local part and then an `@`.
const HTML_START = /[a-z/!?]/i;
const LOCAL_PART = /[a-z0-9.!#$%&'+/=?^{|}~-]/i;
// A `<` at the end of a text node, with the start of a local part after it that has no `@` yet.
const TRAILING_OPENER = /<[a-z0-9.!#$%&'+/=?^{|}~-]*$/i;
const WHITESPACE_CHAR = /\s/;

/**
 * Escapes a text node. `escapeMarkdown` sees only this node, so a `<` at its end is
 * left alone there. Here the next output is known from the DOM: a `<` is escaped when
 * that output may begin with one of the characters that open raw HTML or an autolink.
 * A `<` followed by a space, a line break or the end of its block stays as it is.
 * This `<` escape belongs to the default escaper. A custom `escape` decides every escape itself, so
 * nothing is added after it.
 */
function escapeText(service: TurndownService, node: Node, text: string): string {
    const escaped = service.escape(text);

    if (service.escape !== escapeMarkdown) {
        return escaped;
    }

    // The text may end in a `<` and the start of an email local part, such as `<1`, whose `@` is in the next node.
    const opener = TRAILING_OPENER.exec(text)?.[0];

    // A `<` before a letter, `/`, `!` or `?` is escaped by escapeMarkdown already.
    if (opener === undefined || HTML_START.test(opener.charAt(1)) || !escaped.endsWith(opener)) {
        return escaped;
    }

    if (!isFollowedByHtmlOpener(node, service.options, service.rules, opener.length > 1)) {
        return escaped;
    }

    return `${escaped.slice(0, -opener.length)}\\${opener}`;
}

/**
 * True when the output after the node may begin with a character that opens raw HTML, or with an
 * email autolink. It reads the following text (see `followingText`) only as far as the first
 * character that decides: a letter, `/`, `!` or `?` decides at once, and a local part decides at
 * its `@`. The check is conservative: a `<` that cannot open HTML may still be escaped.
 */
function isFollowedByHtmlOpener(node: Node, options: Options, rules: RuleLookup, isAfterLocalPart: boolean): boolean {
    let isInLocalPart = isAfterLocalPart;

    for (const piece of followingText(node, options, rules)) {
        for (const char of piece) {
            const step: Step = isInLocalPart ? stepInLocalPart(char) : stepAfterLessThan(char);

            if (step === "opens") {
                return true;
            }

            if (step === "ends") {
                return false;
            }

            isInLocalPart = step === "local";
        }
    }

    return false;
}

/** What one character after a `<` decides: it opens markup, it ends the search, it starts a local part, or it is skipped. */
type Step = "opens" | "ends" | "local" | "skip";

function stepAfterLessThan(char: string): Step {
    if (HTML_START.test(char)) {
        return "opens";
    }

    if (LOCAL_PART.test(char)) {
        return "local";
    }

    return WHITESPACE_CHAR.test(char) ? "skip" : "ends";
}

/** Inside a local part, an `@` opens an email autolink, and any other character that is not part of one ends the search. */
function stepInLocalPart(char: string): Step {
    if (char === "@") {
        return "opens";
    }

    return LOCAL_PART.test(char) ? "local" : "ends";
}

/**
 * The text that the output after the node is made of, in order. It looks at the next sibling, then
 * past the end of an inline parent. A link that the rules print ends the search: it closes with `]`.
 * A block ends it too, since a block starts on a new line. An `<a>` that prints no link is looked
 * past, like any inline parent.
 */
function* followingText(node: Node, options: Options, rules: RuleLookup): Generator<string> {
    let current: Node | null = node;

    while (current) {
        for (let sibling = current.nextSibling; sibling; sibling = sibling.nextSibling) {
            yield* textOf(sibling, rules);
        }

        const parent: Node | null = current.parentNode;

        // Only a link that prints brackets closes the text: under safeLinks an unsafe link prints its text alone.
        if (!parent || (parent.nodeName === "A" && isRenderedLink(parent as Element, options)) || isBlock(parent)) {
            return;
        }

        current = parent;
    }
}

/**
 * The text nodes under a node, in order. A comment prints nothing, so it is skipped, and so is an element that a
 * remove rule drops, with everything in it.
 */
function* textOf(node: Node, rules: RuleLookup): Generator<string> {
    if (node.nodeType === 3 || node.nodeType === 4) {
        yield node.nodeValue ?? "";
    } else if (node.nodeType === 1 && rules.ruleFor(node)?.replacement !== removeReplacement) {
        for (let child = node.firstChild; child; child = child.nextSibling) {
            yield* textOf(child, rules);
        }
    }
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
    let content = service.rules.skipsChildren(rule) ? "" : process(service, node).join("");
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

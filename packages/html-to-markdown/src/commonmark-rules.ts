import annotateNode from "./node";
import type { AnnotatedNode, Options, Rule, RuleLookup } from "./types";
import {
    codeText,
    edgeBreaks,
    escapeMarkdown,
    flattenBreaks,
    hasOnlyBreaks,
    isBlock,
    isVoid,
    lineBreakMarker,
    parseListStart,
    repeat,
    trimNewlines,
} from "./utilities";

const LINE_START = /^/gm;
const NEWLINE = /\n/g;
const NON_BLANK = /\S/;
const TRAILING_INDENTED_BREAK = /\n *$/;
const TRAILING_NEWLINE = /\n$/;
const LINE_BREAKS = /\r?\n|\r/g;
const BACKTICKS = /`+/g;
const BACKTICK_EDGE = /^`|`$/;
const LANGUAGE_CLASS = /language-(\S+)/;
const LINE_BREAK_RUN = /\n\s*/g;
const DOUBLE_QUOTE = /"/g;
// A character that can sit next to emphasis without `_` failing to open or close: anything but
// whitespace, punctuation and symbols (CommonMark's flanking rules).
const WORD_CHARACTER = /^[^\s\p{P}\p{S}]$/u;
const EMPHASIS_NAMES = new Set(["em", "i"]);
const STRONG_NAMES = new Set(["b", "strong"]);
// Elements whose output starts or ends with a delimiter, so their edge is never a word character.
const DELIMITED_NAMES = new Set(["a", "b", "code", "em", "i", "strong"]);

interface RunStyle {
    /** The delimiter for a run that touches a word character. */
    intraword: string;
    /** The element names that share a run with this one. */
    names: ReadonlySet<string>;
    /** The delimiter for a run that stands alone in a word-free context. */
    plain: string;
}

// A line break, then whitespace that holds another line break. Linear: the scan starts
// only at a line break, and the whitespace after it is consumed once.
const BLANK_LINE = /\n\s*\n/g;

/**
 * Reference-style links collect their definitions here and append them after
 * the document (see `append`). The state lives on this rule object, as in
 * upstream; the rule is shared by every converter in the process.
 */
function isReferencedLink(node: AnnotatedNode, options: Options): boolean {
    return options.linkStyle === "referenced" && node.nodeName === "A" && Boolean(node.getAttribute("href"));
}

class ReferenceLinkRule implements Rule {
    references: string[] = [];

    filter = isReferencedLink;

    replacement(content: string, node: AnnotatedNode, options: Options): string {
        const rawHref = node.getAttribute("href") ?? "";

        if (options.safeLinks && isUnsafeDestination(rawHref)) {
            return content;
        }

        const text = linkText(content);
        const href = escapeLinkDestination(rawHref, options.safeLinks);
        let title = cleanAttribute(node.getAttribute("title"));

        if (title) {
            title = ` "${escapeLinkTitle(title)}"`;
        }

        let replacement: string;
        let reference: string;

        switch (options.linkReferenceStyle) {
            case "collapsed": {
                replacement = `[${text}][]`;
                reference = `[${text}]: ${href}${title}`;
                break;
            }
            case "shortcut": {
                replacement = `[${text}]`;
                reference = `[${text}]: ${href}${title}`;
                break;
            }
            default: {
                const id = this.references.length + 1;

                replacement = `[${text}][${id}]`;
                reference = `[${id}]: ${href}${title}`;
            }
        }

        this.references.push(reference);

        return replacement;
    }

    append(): string {
        let references = "";

        if (this.references.length > 0) {
            references = `\n\n${this.references.join("\n")}\n\n`;
            this.references = []; // Reset references
        }

        return references;
    }
}

const rules: Record<string, Rule> = {
    blockquote: {
        filter: "blockquote",

        replacement(content) {
            const quoted = trimNewlines(content).replaceAll(LINE_START, "> ");

            return `\n\n${quoted}\n\n`;
        },
    },

    code: {
        filter(node) {
            const hasSiblings = Boolean(node.previousSibling || node.nextSibling);
            const isCodeBlock = node.parentNode?.nodeName === "PRE" && !hasSiblings;

            return node.nodeName === "CODE" && !isCodeBlock;
        },

        replacement(content) {
            if (!content) {
                return "";
            }

            const flat = content.replaceAll(LINE_BREAKS, " ");

            const extraSpace = BACKTICK_EDGE.test(flat) || isSpacePadded(flat) ? " " : "";
            let delimiter = "`";
            const matches: string[] = flat.match(BACKTICKS) ?? [];

            while (matches.includes(delimiter)) {
                delimiter += "`";
            }

            return delimiter + extraSpace + flat + extraSpace + delimiter;
        },
    },

    emphasis: {
        filter: ["em", "i"],

        replacement(content, node, options) {
            return wrapRun(content, node, options, { intraword: "*", names: EMPHASIS_NAMES, plain: options.emDelimiter });
        },
    },

    fencedCodeBlock: {
        filter(node, options, lookup) {
            return options.codeBlockStyle === "fenced" && node.nodeName === "PRE" && preCodeElement(node, lookup) !== null;
        },

        replacement(_content, node, options, lookup) {
            const codeElement = preCodeElement(node, lookup);
            const className = codeElement?.getAttribute("class") ?? "";
            const language = (LANGUAGE_CLASS.exec(className) ?? [null, ""])[1];
            const code = codeElement ? codeText(codeElement) : "";

            const fenceChar = options.fence.charAt(0);
            let fenceSize = 3;
            const fenceInCodeRegex = new RegExp(`^${fenceChar}{3,}`, "gm");

            let match: RegExpExecArray | null = fenceInCodeRegex.exec(code);

            while (match) {
                if (match[0].length >= fenceSize) {
                    fenceSize = match[0].length + 1;
                }

                match = fenceInCodeRegex.exec(code);
            }

            const fence = repeat(fenceChar, fenceSize);

            return `\n\n${fence}${language}\n${code.replace(TRAILING_NEWLINE, "")}\n${fence}\n\n`;
        },
    },

    heading: {
        filter: ["h1", "h2", "h3", "h4", "h5", "h6"],

        replacement(content, node, options) {
            const hLevel = Number(node.nodeName.charAt(1));
            // A heading is one line, so a hard break in it becomes a space.
            const text = node.querySelector("br") ? flattenBreaks(content, lineBreakMarker(options.br), hasBlockDescendant(node)) : content;

            if (options.headingStyle === "setext" && hLevel < 3) {
                const underline = repeat(hLevel === 1 ? "=" : "-", text.length);

                return `\n\n${text}\n${underline}\n\n`;
            }

            return `\n\n${repeat("#", hLevel)} ${text}\n\n`;
        },
    },

    horizontalRule: {
        filter: "hr",

        replacement(_content, _node, options) {
            return `\n\n${options.hr}\n\n`;
        },
    },

    image: {
        filter: "img",

        replacement(_content, node) {
            const alt = escapeMarkdown(cleanAttribute(node.getAttribute("alt")));
            const src = escapeLinkDestination(node.getAttribute("src") ?? "");
            const title = cleanAttribute(node.getAttribute("title"));
            const titlePart = title ? ` "${escapeLinkTitle(title)}"` : "";

            return src ? `![${alt}](${src}${titlePart})` : "";
        },
    },

    indentedCodeBlock: {
        filter(node, options, lookup) {
            return options.codeBlockStyle === "indented" && node.nodeName === "PRE" && preCodeElement(node, lookup) !== null;
        },

        replacement(_content, node, _options, lookup) {
            const codeElement = preCodeElement(node, lookup);
            const code = codeElement ? codeText(codeElement) : "";

            return `\n\n    ${code.replaceAll(NEWLINE, "\n    ")}\n\n`;
        },
    },

    inlineLink: {
        filter(node, options) {
            return options.linkStyle === "inlined" && node.nodeName === "A" && Boolean(node.getAttribute("href"));
        },

        replacement(content, node, options) {
            const rawHref = node.getAttribute("href") ?? "";

            if (options.safeLinks && isUnsafeDestination(rawHref)) {
                return content;
            }

            const href = escapeLinkDestination(rawHref, options.safeLinks);
            const title = escapeLinkTitle(cleanAttribute(node.getAttribute("title")));
            const titlePart = title ? ` "${title}"` : "";

            return `[${linkText(content)}](${href}${titlePart})`;
        },
    },

    lineBreak: {
        filter: "br",

        replacement(_content, _node, options) {
            return lineBreakMarker(options.br);
        },
    },

    list: {
        filter: ["ul", "ol"],

        replacement(content, node) {
            const parent = node.parentNode as Element | null;

            if (parent?.nodeName === "LI" && parent.lastElementChild === node) {
                if (!hasTextAfter(node)) {
                    return `\n${content}`;
                }

                // Text after the list needs a blank line. Without one, CommonMark reads the
                // text as a lazy continuation of the last sub-item's paragraph. An item that
                // ends in a block or a `<br>` already ends in a line break and its indent, so
                // it needs one more.
                return `\n${content}${TRAILING_INDENTED_BREAK.test(content) ? "\n" : "\n\n"}`;
            }

            return `\n\n${content}\n\n`;
        },
    },

    listItem: {
        filter: "li",

        replacement(content, node, options) {
            let prefix = `${options.bulletListMarker}   `;
            const parent = node.parentNode as Element | null;

            if (parent?.nodeName === "OL") {
                const start = parseListStart(parent.getAttribute("start")) ?? 1n;
                const index = Array.prototype.indexOf.call(parent.children, node);

                prefix = `${start + BigInt(index)}.  `;
            }

            const isParagraph = TRAILING_NEWLINE.test(content);
            let body = trimNewlines(content) + (isParagraph ? "\n" : "");

            // indent: every line break gets the prefix's width in spaces
            body = body.split("\n").join(`\n${" ".repeat(prefix.length)}`);

            return prefix + body + (node.nextSibling ? "\n" : "");
        },
    },

    paragraph: {
        filter: "p",

        replacement(content) {
            return `\n\n${content}\n\n`;
        },
    },

    referenceLink: new ReferenceLinkRule(),

    strong: {
        filter: ["strong", "b"],

        replacement(content, node, options) {
            return wrapRun(content, node, options, { intraword: "**", names: STRONG_NAMES, plain: options.strongDelimiter });
        },
    },
};

const LINE_TERMINATORS = new Set(["\n", "\r", "\u{2028}", "\u{2029}"]);

/**
 * Linear equivalent of the regular expression `/^ .*?[^ ].* $/`, which backtracks
 * polynomially on long inputs. It matches when the text starts and ends with a
 * space and has a non-space character between them, with no line terminator
 * between the first space and that character, or between it and the last space
 * (`.` does not match line terminators).
 */
function isSpacePadded(text: string): boolean {
    const last = text.length - 1;

    if (last < 2 || text[0] !== " " || text[last] !== " ") {
        return false;
    }

    let terminators = 0;
    let hasNonSpace = false;

    for (let index = 1; index < last; index += 1) {
        const char = text[index] ?? "";

        if (LINE_TERMINATORS.has(char)) {
            terminators += 1;
        }

        if (char !== " ") {
            hasNonSpace = true;
        }
    }

    // With no terminator, any non-space will do. With exactly one, that
    // character itself is the non-space that the pattern needs.
    return terminators === 0 ? hasNonSpace : terminators === 1;
}

const SCHEME = /^([a-z][\d+.a-z-]*):/i;
const TAB_OR_NEWLINE = /[\t\n\r]/g;
const BACKSLASH_ESCAPE = /\\([!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-])/g;
const NUMERIC_REFERENCE = /&#(?:(\d+)|x([\da-f]+));?/gi;
const HEAD_END = /[/?#]/;
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * True when a link destination has a scheme outside `SAFE_SCHEMES` (`javascript:`, `data:`, `vbscript:`, `file:`...).
 * A destination with no scheme is relative and kept.
 *
 * The check runs on a decoded copy of the destination. Backslash escapes of ASCII punctuation and numeric character
 * references (decimal or hex, `;` optional) are decoded first. Then leading and trailing C0 controls and spaces are
 * dropped and tabs and line breaks removed, the way a browser reads an `href`. A named reference such as `&colon;` is
 * not decoded, so a `&` that remains before the first `/`, `?` or `#` makes the destination unsafe: it could spell a
 * scheme. Numeric references are decoded before that test, so `&#0;javascript:alert(1)` becomes U+FFFD followed by
 * `javascript:alert(1)`, which has no scheme, and is kept. A plain scheme regular expression is used instead of
 * `new URL`, which throws on a relative URL and on some schemes with a bad host; those must not pass as relative.
 */
function isUnsafeDestination(href: string): boolean {
    const decoded = stripUrlNoise(decodeDestination(href));
    const head = decoded.split(HEAD_END, 1)[0] ?? "";

    if (head.includes("&")) {
        return true;
    }

    const scheme = SCHEME.exec(decoded)?.[1];

    return scheme !== undefined && !SAFE_SCHEMES.has(scheme.toLowerCase());
}

function decodeDestination(href: string): string {
    return href.replaceAll(BACKSLASH_ESCAPE, "$1").replaceAll(NUMERIC_REFERENCE, (_match, decimal?: string, hex?: string) => {
        const codePoint = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number(decimal);

        return codePoint > 0 && codePoint <= 1_114_111 ? String.fromCodePoint(codePoint) : "�";
    });
}

function stripUrlNoise(href: string): string {
    let start = 0;
    let end = href.length;

    while (start < end && (href.codePointAt(start) ?? 0) <= 0x20) {
        start += 1;
    }

    while (end > start && (href.codePointAt(end - 1) ?? 0) <= 0x20) {
        end -= 1;
    }

    return href.slice(start, end).replaceAll(TAB_OR_NEWLINE, "");
}

function hasTextAfter(node: Node): boolean {
    for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
        if (sibling.nodeType === 3 && NON_BLANK.test(sibling.nodeValue ?? "")) {
            return true;
        }
    }

    return false;
}

/**
 * The `<code>` that a `<pre>` holds as its block, or null when the `<pre>` is not
 * a code block. A `<pre>` whose first child is `<code>` is one. Otherwise the
 * `<pre>` must hold a single `<code>`, apart from whitespace, possibly wrapped in
 * `<div>` or `<span>` elements that hold nothing else. Any other content, such as
 * a link around the code, keeps the `<pre>` as text. A wrapper that a custom, keep
 * or remove rule claims is not transparent, so its rule's output is not dropped.
 */
function preCodeElement(pre: Node, lookup: RuleLookup): Element | null {
    if (pre.firstChild?.nodeName === "CODE") {
        return pre.firstChild as Element;
    }

    return soleCodeElement(pre, lookup);
}

// Elements with no rule of their own here. Any other element changes the output
// (a link, bold text), so it is not a wrapper.
const WRAPPER_ELEMENTS = new Set(["DIV", "SPAN"]);

function soleCodeElement(parent: Node, lookup: RuleLookup): Element | null {
    let only: Node | null = null;

    for (let child = parent.firstChild; child; child = child.nextSibling) {
        // A comment (node type 8) is not content, like blank text.
        if (child.nodeType === 8 || (child.nodeType === 3 && !NON_BLANK.test(child.nodeValue ?? ""))) {
            continue;
        }

        if (only) {
            return null;
        }

        only = child;
    }

    if (only?.nodeType !== 1) {
        return null;
    }

    if (only.nodeName === "CODE") {
        return only as Element;
    }

    return WRAPPER_ELEMENTS.has(only.nodeName) && !lookup.hasRuleFor(only) ? soleCodeElement(only, lookup) : null;
}

type Side = "left" | "right";

interface EmphasisRun {
    /** Emphasis elements next to this one, with no text, space or break between them. */
    count: number;
    /** True when the output past them touches a word character. */
    wordEdge: boolean;
}

/**
 * Wraps an emphasis or strong element. Adjacent elements of the same kind form one
 * run: only the first opens it and only the last closes it, so `<i>1</i><em>2</em>`
 * gives `_12_`. A run that touches a word character uses `*` (or `**`), because `_`
 * cannot open or close inside a word.
 */
function wrapRun(content: string, node: AnnotatedNode, options: Options, style: RunStyle): string {
    // A same-kind parent writes the delimiters for the whole run, so a nested element writes none.
    // A parent with a block (even a blank one, which prints a break) never shares its delimiters, so the nested element keeps its own.
    const parent = node.parentNode;

    if (parent && style.names.has(parent.nodeName.toLowerCase()) && !hasPrintingBlockDescendant(parent, options)) {
        return wrapInline(content, options, "", "");
    }

    const before = emphasisRun(node, "left", style.names, options);
    const after = emphasisRun(node, "right", style.names, options);
    const delimiter = before.wordEdge || after.wordEdge ? style.intraword : style.plain;

    return wrapInline(content, options, before.count === 0 ? delimiter : "", after.count === 0 ? delimiter : "");
}

/**
 * Wraps content in an opening and a closing delimiter (either may be empty). The
 * line breaks at its ends go outside the delimiters, where a break is valid.
 */
function wrapInline(content: string, options: Options, open: string, close: string): string {
    const { core, lead, trail } = splitBreaks(content, lineBreakMarker(options.br));

    if (!core.trim()) {
        return lead + trail;
    }

    return lead + open + core + close + trail;
}

/** Splits the line break markers off both ends of content. */
function splitBreaks(content: string, marker: string): { core: string; lead: string; trail: string } {
    let start = 0;

    while (content.startsWith(marker, start)) {
        start += marker.length;
    }

    let end = content.length;

    while (end - marker.length >= start && content.startsWith(marker, end - marker.length)) {
        end -= marker.length;
    }

    return { core: content.slice(start, end), lead: content.slice(0, start), trail: content.slice(end) };
}

/**
 * Steps taken by the emphasis walks: each sibling visited and each child checked for a block.
 * The scale tests read it to show that a long run costs work in proportion to its length.
 */
export const emphasisSteps = { count: 0 };

/** Each member's walk to one side, per side, so a run is walked once rather than once from every member. */
const leftRuns = new WeakMap<Node, EmphasisRun>();
const rightRuns = new WeakMap<Node, EmphasisRun>();

/**
 * Walks from an emphasis element to one side, over the emphasis elements that
 * are output directly beside it. The walk stops at whitespace, at a line break,
 * and at the first node that outputs something else.
 */
function emphasisRun(node: AnnotatedNode, side: Side, names: ReadonlySet<string>, options: Options): EmphasisRun {
    const known = side === "left" ? leftRuns : rightRuns;
    const chain: AnnotatedNode[] = [];
    let current = node;
    let run = known.get(current);

    while (!run) {
        const step = scanRun(current, side, names, options);

        if ("run" in step) {
            run = step.run;
            known.set(current, run);
        } else {
            chain.push(current);
            current = step.member;
            run = known.get(current);
        }
    }

    // Each node in the chain has one more member after it than the node that follows it.
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        run = { count: run.count + 1, wordEdge: run.wordEdge };
        known.set(chain[index] as AnnotatedNode, run);
    }

    return run;
}

/**
 * One step of an emphasis walk: either the next member, whose own walk continues the run,
 * or the end of the run. A member's answer depends only on that member, so `emphasisRun`
 * can store it.
 */
function scanRun(node: AnnotatedNode, side: Side, names: ReadonlySet<string>, options: Options): { member: AnnotatedNode } | { run: EmphasisRun } {
    const gap = separation(node, side);
    let sibling = neighbour(node, side);
    // An element with a block inside it never merges, because the block would end the delimiter.
    const canMerge = !hasBlockDescendant(node);

    while (sibling && gap !== Infinity) {
        emphasisSteps.count += 1;

        if (canMerge && isRunMember(sibling, names, options)) {
            const member = annotationOf(sibling, options);

            // Two emphasis elements join across at most one break; two breaks would be a blank line.
            if (gap + separation(member, opposite(side)) > 1) {
                break;
            }

            return { member };
        }

        // A break keeps the next output apart from the run, so it cannot touch a word.
        if (gap > 0) {
            break;
        }

        const edge = edgeCharacter(sibling, side, options);

        if (edge !== null) {
            return { run: { count: 0, wordEdge: WORD_CHARACTER.test(edge) } };
        }

        sibling = neighbour(sibling, side);
    }

    return { run: { count: 0, wordEdge: false } };
}

/**
 * The line breaks between a node and its neighbour on one side, or infinity when
 * whitespace lies there, which keeps the two apart whatever comes next.
 */
function separation(node: AnnotatedNode, side: Side): number {
    return flankOf(node, side) === "" ? edgeBreaks(node, side) : Infinity;
}

/** True for an element of the same kind that outputs delimiters, so it can share a run with this one. */
function isRunMember(node: Node, names: ReadonlySet<string>, options: Options): boolean {
    if (node.nodeType !== 1 || !names.has(node.nodeName.toLowerCase())) {
        return false;
    }

    return !annotationOf(node, options).isBlank && !hasOnlyBreaks(node) && !hasBlockDescendant(node);
}

const annotations = new WeakMap<Node, AnnotatedNode>();

/**
 * The annotation of a node, computed once. A run walks the same siblings from each of its
 * members, and annotating a node reads its text, so an uncached walk is quadratic.
 */
function annotationOf(node: Node, options: Options): AnnotatedNode {
    let annotated = annotations.get(node);

    if (!annotated) {
        annotated = annotateNode(node, options);
        annotations.set(node, annotated);
    }

    return annotated;
}

/** True when a block element sits inside the node, at any depth. */
function hasBlockDescendant(node: Node): boolean {
    for (const child of node.childNodes) {
        if (child.nodeType === 1 && (isBlock(child) || hasBlockDescendant(child))) {
            return true;
        }
    }

    return false;
}

/** Whether each node has a printing block descendant, stored because every child of a same-kind parent asks. */
const printingBlockDescendants = new WeakMap<Node, boolean>();

/**
 * True when a block sits inside the node, at any depth. A blank block still counts: its
 * separator (see `blankReplacement`) is a paragraph break, which splits the parent's
 * delimiters. A blank element that is not a block is skipped, with its contents, because it
 * prints nothing and so cannot split them.
 */
function hasPrintingBlockDescendant(node: Node, options: Options): boolean {
    const known = printingBlockDescendants.get(node);

    if (known !== undefined) {
        return known;
    }

    let hasPrinting = false;

    for (const child of node.childNodes) {
        if (child.nodeType !== 1) {
            continue;
        }

        emphasisSteps.count += 1;

        if (isBlock(child) || (!annotationOf(child, options).isBlank && hasPrintingBlockDescendant(child, options))) {
            hasPrinting = true;
            break;
        }
    }

    printingBlockDescendants.set(node, hasPrinting);

    return hasPrinting;
}

/**
 * A void element prints markup for a break (which ends a run) and for an image with a
 * source. Any other void element, such as a word-break hint or an input, prints nothing,
 * so the run looks past it to the text beyond.
 */
function voidEdge(element: Element): string | null {
    if (element.nodeName === "BR") {
        return "";
    }

    return element.nodeName === "IMG" && element.getAttribute("src") ? "" : null;
}

/**
 * The character a node's output shows on the side facing the emphasis: "" when
 * the output ends in markup, a void element that prints markup or a block boundary,
 * and null when the node outputs nothing.
 */
function edgeCharacter(node: Node, side: Side, options: Options): string | null {
    if (node.nodeType === 3) {
        return textEdge(node.nodeValue ?? "", side);
    }

    if (node.nodeType !== 1) {
        return null;
    }

    const element = node as Element;
    const annotated = annotationOf(element, options);

    if (annotated.isBlock) {
        return "";
    }

    if (isVoid(element)) {
        return voidEdge(element);
    }

    const name = element.nodeName.toLowerCase();

    if (DELIMITED_NAMES.has(name) && (name !== "a" || isRenderedLink(element, options))) {
        // A blank element that outputs a space ends a run like a space does; an empty one outputs nothing.
        if (annotated.isBlank) {
            return element.textContent ? " " : null;
        }

        return "";
    }

    return childEdge(element, side, options);
}

/**
 * True when an anchor renders as a Markdown link, with brackets. An anchor with no href,
 * a link style that writes no link, or an unsafe destination under safe links renders
 * only its text.
 */
function isRenderedLink(element: Element, options: Options): boolean {
    const href = element.getAttribute("href");

    if (!href || (options.linkStyle !== "inlined" && options.linkStyle !== "referenced")) {
        return false;
    }

    return !(options.safeLinks && isUnsafeDestination(href));
}

function textEdge(text: string, side: Side): string | null {
    const chars = [...text];

    return chars[side === "left" ? chars.length - 1 : 0] ?? null;
}

/** The edge of the first child, from the facing end, that outputs something. */
function childEdge(element: Element, side: Side, options: Options): string | null {
    let child = side === "left" ? element.lastChild : element.firstChild;

    while (child) {
        const edge = edgeCharacter(child, side, options);

        if (edge !== null) {
            return edge;
        }

        child = side === "left" ? child.previousSibling : child.nextSibling;
    }

    return null;
}

function neighbour(node: Node, side: Side): Node | null {
    return side === "left" ? node.previousSibling : node.nextSibling;
}

function opposite(side: Side): Side {
    return side === "left" ? "right" : "left";
}

/** The whitespace that the flanking rules move outside a node, on one side. */
function flankOf(node: AnnotatedNode, side: Side): string {
    return side === "left" ? node.flankingWhitespace.leading : node.flankingWhitespace.trailing;
}

function cleanAttribute(attribute: string | null): string {
    // `\n\s*` collapses each run of line breaks (and the blanks after them) to one
    // line break. It matches upstream's `(\n+\s*)+` without nested quantifiers.
    return attribute ? attribute.replaceAll(LINE_BREAK_RUN, "\n") : "";
}

/**
 * Link text cannot hold a blank line, which ends the paragraph and leaves the
 * brackets as plain text. A block element inside a link puts one there, so each
 * blank line becomes a space. A single line break stays: CommonMark keeps link
 * text across it.
 */
function linkText(content: string): string {
    return content.replaceAll(BLANK_LINE, " ");
}

/**
 * A backslash escapes the ASCII punctuation character after it, and at the end of
 * the destination it would escape the closing parenthesis. Such a backslash is
 * doubled. Any other backslash is literal, so it is left alone.
 */
const BACKSLASH_BEFORE_PUNCTUATION = /\\(?=[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~]|$)/g;

/**
 * With `safeLinks`, `\` and `&` are escaped too. CommonMark undoes those added escapes, so the rendered destination is
 * the raw attribute, not the decoded copy. The check already covers the raw attribute: `isUnsafeDestination` runs on a
 * decoded copy of that same text. Line breaks are dropped first, as a browser drops them from an `href`, so the
 * destination stays on one line and cannot start a reference definition. Every backslash is doubled in safe mode, so
 * the punctuation rule is applied only outside it.
 */
function escapeLinkDestination(destination: string, isSafeLinks = false): string {
    const oneLine = destination.replaceAll(LINE_BREAKS, "");
    const escaped = (
        isSafeLinks ? oneLine.replaceAll("\\", "\\\\").replaceAll("&", "&amp;") : oneLine.replaceAll(BACKSLASH_BEFORE_PUNCTUATION, String.raw`\\`)
    )
        .replaceAll("<", String.raw`\<`)
        .replaceAll(">", String.raw`\>`)
        .replaceAll("(", String.raw`\(`)
        .replaceAll(")", String.raw`\)`);

    return escaped.includes(" ") ? `<${escaped}>` : escaped;
}

function escapeLinkTitle(title: string): string {
    return title.replaceAll(DOUBLE_QUOTE, String.raw`\"`);
}

export default rules;

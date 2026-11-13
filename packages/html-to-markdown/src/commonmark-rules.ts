import annotateNode from "./node";
import type { AnnotatedNode, Options, Rule, RuleLookup } from "./types";
import {
    codeText,
    defaultBlankReplacement,
    defaultElementReplacement,
    edgeBreaks,
    escapeMarkdown,
    hasOnlyBreaks,
    isBlock,
    isVoid,
    lineBreakMarker,
    parseListStart,
    removeReplacement,
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
const WHITESPACE_EDGE = /^\s$/u;
// A word character: anything but whitespace, punctuation and symbols. Emphasis that touches one is intraword, where
// `_` cannot open or close (CommonMark's flanking rules), so a run that touches one uses `*`.
const WORD_CHARACTER = /^[^\s\p{P}\p{S}]$/u;
const EMPHASIS_NAMES = new Set(["em", "i"]);
const STRONG_NAMES = new Set(["b", "strong"]);
// Elements whose output starts or ends with a delimiter, so their edge is never a word character.
const DELIMITED_NAMES = new Set(["a", "b", "code", "em", "i", "strong"]);
const HEADING_NAMES = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
// Each heading's break mark, or undefined for a heading without one. Filled by headingMarkOf.
const headingMarks = new WeakMap<Node, string | undefined>();
const TRAILING_SPACE = / $/;
const LEADING_SPACE = /^ /;

interface RunStyle {
    /** The delimiter for a run that touches a word character. */
    intraword: string;
    /** The element names that share a run with this one. */
    names: ReadonlySet<string>;
    /** The delimiter for a run that stands alone in a word-free context. */
    plain: string;
}

// The <code> each selected <pre> was matched with. The replacement reads it from here
// rather than searching again: a rule that claims a wrapper after the match would make
// the search find nothing, and the block would lose its code.
const pinnedCode = new WeakMap<Node, Element>();

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

    replacement(rawContent: string, node: AnnotatedNode, options: Options, lookup: RuleLookup): string {
        const rawHref = node.getAttribute("href") ?? "";

        if (options.safeLinks && isUnsafeDestination(rawHref)) {
            return rawContent;
        }

        // The reference definition is written after the document, out of the heading's reach, so a heading's break
        // marks are turned into spaces here; otherwise the label in the heading and the definition would differ.
        const mark = breakMarkFor(node, lookup);
        const { lead, text, trail } = headingLinkParts(rawContent, mark);
        const content = mark === undefined ? text : joinAtMarks(text, mark);

        const href = escapeLinkDestination(rawHref, options.safeLinks);
        let title = cleanAttribute(node.getAttribute("title"));

        if (title) {
            title = ` "${escapeLinkTitle(title)}"`;
        }

        let replacement: string;
        let reference: string;

        switch (options.linkReferenceStyle) {
            case "collapsed": {
                replacement = `[${content}][]`;
                reference = `[${content}]: ${href}${title}`;
                break;
            }
            case "shortcut": {
                replacement = `[${content}]`;
                reference = `[${content}]: ${href}${title}`;
                break;
            }
            default: {
                const id = this.references.length + 1;

                replacement = `[${content}][${id}]`;
                reference = `[${id}]: ${href}${title}`;
            }
        }

        this.references.push(reference);

        return lead + replacement + trail;
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

        replacement(content, node, options, lookup) {
            return wrapRun(content, node, options, { intraword: "*", names: EMPHASIS_NAMES, plain: options.emDelimiter }, lookup);
        },
    },

    fencedCodeBlock: {
        filter(node, options, lookup) {
            return options.codeBlockStyle === "fenced" && node.nodeName === "PRE" && pinnedCodeElement(node, lookup) !== null;
        },

        replacement(_content, node, options, lookup) {
            const codeElement = pinnedCode.get(node) ?? preCodeElement(node, lookup);
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

        replacement(content, node, options, lookup) {
            const hLevel = Number(node.nodeName.charAt(1));
            const text = headingText(content, node, lookup);

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
            return options.codeBlockStyle === "indented" && node.nodeName === "PRE" && pinnedCodeElement(node, lookup) !== null;
        },

        replacement(_content, node, _options, lookup) {
            const codeElement = pinnedCode.get(node) ?? preCodeElement(node, lookup);
            const code = codeElement ? codeText(codeElement) : "";

            return `\n\n    ${code.replaceAll(NEWLINE, "\n    ")}\n\n`;
        },
    },

    inlineLink: {
        filter(node, options) {
            return options.linkStyle === "inlined" && node.nodeName === "A" && Boolean(node.getAttribute("href"));
        },

        replacement(content, node, options, lookup) {
            const rawHref = node.getAttribute("href") ?? "";

            if (options.safeLinks && isUnsafeDestination(rawHref)) {
                return content;
            }

            const href = escapeLinkDestination(rawHref, options.safeLinks);
            const title = escapeLinkTitle(cleanAttribute(node.getAttribute("title")));
            const titlePart = title ? ` "${title}"` : "";
            const { lead, text, trail } = headingLinkParts(content, breakMarkFor(node, lookup));

            return `${lead}[${text}](${href}${titlePart})${trail}`;
        },
    },

    lineBreak: {
        filter: "br",

        replacement(_content, node, options, lookup) {
            return breakMarkFor(node, lookup) ?? lineBreakMarker(options.br);
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

        replacement(content, node, options, lookup) {
            return wrapRun(content, node, options, { intraword: "**", names: STRONG_NAMES, plain: options.strongDelimiter }, lookup);
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

function pinnedCodeElement(pre: Node, lookup: RuleLookup): Element | null {
    const code = preCodeElement(pre, lookup);

    if (code) {
        pinnedCode.set(pre, code);
    }

    return code;
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
function wrapRun(content: string, node: AnnotatedNode, options: Options, style: RunStyle, lookup: RuleLookup): string {
    // A same-kind parent writes the delimiters for the whole run, so a nested element writes none. That holds only
    // when the built-in rule renders the parent: a custom rule writes its own output and no delimiters.
    // A parent with a block (even a blank one, which prints a break) never shares its delimiters, so the nested element keeps its own.
    if (hasSharingParent(node.parentNode, style, options, lookup)) {
        return wrapInline(content, options, "", "", breakMarkFor(node, lookup));
    }

    const before = emphasisRun(node, "left", style.names, options, lookup);
    const after = emphasisRun(node, "right", style.names, options, lookup);
    const delimiter = before.wordEdge || after.wordEdge ? style.intraword : style.plain;
    const breakMark = breakMarkFor(node, lookup);

    return wrapInline(content, options, before.count === 0 ? delimiter : "", after.count === 0 ? delimiter : "", breakMark);
}

/**
 * Wraps content in an opening and a closing delimiter (either may be empty). The
 * line breaks at its ends go outside the delimiters, where a break is valid.
 */
function wrapInline(content: string, options: Options, open: string, close: string, breakMark?: string): string {
    const { core, lead, trail } = splitBreaks(content, lineBreakMarker(options.br), breakMark);

    if (!core.trim()) {
        return lead + trail;
    }

    return lead + open + core + close + trail;
}

/**
 * Splits the line break markers off both ends of content. `breakMark` is a heading's break mark (see
 * headingBreakMark), which splits off the same way, so a break inside emphasis stays outside its delimiters.
 */
function splitBreaks(content: string, marker: string, breakMark?: string): { core: string; lead: string; trail: string } {
    const tokens = breakMark === undefined ? [marker] : [marker, breakMark];
    let start = 0;
    let length = tokenStartingAt(content, tokens, start);

    while (length > 0) {
        start += length;
        length = tokenStartingAt(content, tokens, start);
    }

    let end = content.length;

    length = tokenEndingAt(content, tokens, end, start);

    while (length > 0) {
        end -= length;
        length = tokenEndingAt(content, tokens, end, start);
    }

    return { core: content.slice(start, end), lead: content.slice(0, start), trail: content.slice(end) };
}

/** The length of the first token that starts at `position`, or 0. */
function tokenStartingAt(content: string, tokens: ReadonlyArray<string>, position: number): number {
    return tokens.find((token) => content.startsWith(token, position))?.length ?? 0;
}

/** The length of the first token that ends at `end` without reaching before `start`, or 0. */
function tokenEndingAt(content: string, tokens: ReadonlyArray<string>, end: number, start: number): number {
    return tokens.find((token) => end - token.length >= start && content.startsWith(token, end - token.length))?.length ?? 0;
}

/** Each member's walk to one side, per side, so a run is walked once rather than once from every member. */
const leftRuns = new WeakMap<Node, EmphasisRun>();
const rightRuns = new WeakMap<Node, EmphasisRun>();

/**
 * Walks from an emphasis element to one side, over the emphasis elements that
 * are output directly beside it. The walk stops at whitespace, at a line break,
 * and at the first node that outputs something else.
 */
function emphasisRun(node: AnnotatedNode, side: Side, names: ReadonlySet<string>, options: Options, lookup: RuleLookup): EmphasisRun {
    const known = side === "left" ? leftRuns : rightRuns;
    const chain: AnnotatedNode[] = [];
    let current = node;
    let run = known.get(current);

    while (!run) {
        const step = scanRun(current, side, names, options, lookup);

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
function scanRun(
    node: AnnotatedNode,
    side: Side,
    names: ReadonlySet<string>,
    options: Options,
    lookup: RuleLookup,
): { member: AnnotatedNode } | { run: EmphasisRun } {
    const gap = separation(node, side);
    let sibling = neighbourThroughWrappers(node, side, options, lookup);
    // An element merges only if it would be a run member itself: the walk from its neighbour applies the same test,
    // so the two walks agree. That also keeps out an element with a block inside, which would end the delimiter.
    const canMerge = isRunMember(node, names, options, lookup);

    while (sibling && gap !== Infinity) {
        if (canMerge && isRunMember(sibling, names, options, lookup)) {
            const member = annotationOf(sibling, options);

            // Two emphasis elements join across at most one break; two breaks would be a blank line. When a single
            // break is itself written as a blank line (a `br` with a newline), they cannot join across any break.
            if (gap + separation(member, opposite(side)) > maxJoinBreaks(options)) {
                break;
            }

            return { member };
        }

        const inner = wrapperEntry(sibling, side, options, lookup);

        // A wrapper that prints its content as is is invisible to the run: the walk steps into it.
        if (inner) {
            sibling = inner;
            continue;
        }

        const edgeRun = siblingEdgeRun(sibling, side, options, lookup);

        // A sibling that prints nothing (a comment, an empty span) is stepped over in both directions, so the two
        // members' walks agree about the run. A printing sibling ends the run; after a break it cannot touch a word.
        if (edgeRun) {
            return { run: gap > 0 ? { count: 0, wordEdge: false } : edgeRun };
        }

        sibling = neighbourThroughWrappers(sibling, side, options, lookup);
    }

    return { run: { count: 0, wordEdge: false } };
}

/** How many hard breaks two emphasis elements may share delimiters across: none when a break writes a blank line. */
function maxJoinBreaks(options: Options): number {
    return lineBreakMarker(options.br).includes("\n\n") ? 0 : 1;
}

/**
 * The run end that a printing sibling gives, or null when the sibling prints nothing. A custom rule writes its
 * own output, so the DOM says nothing about its edge; the run then takes the asterisk, valid against any edge.
 */
function siblingEdgeRun(sibling: Node, side: Side, options: Options, lookup: RuleLookup): EmphasisRun | null {
    // A caller's blankReplacement may print anything for a blank element, so the edge is unknown: take the asterisk.
    if (options.blankReplacement !== defaultBlankReplacement && sibling.nodeType === 1 && annotationOf(sibling, options).isBlank) {
        return { count: 0, wordEdge: true };
    }

    const rule = lookup.ruleFor(sibling);

    // A removed element writes only its flanking whitespace, which ends the run like a space.
    if (rule?.replacement === removeReplacement) {
        // Whitespace on either side ends the run, so the walks from both members reach the same answer about it.
        const text = sibling.textContent ?? "";

        return WHITESPACE_EDGE.test(textEdge(text, "left") ?? "") || WHITESPACE_EDGE.test(textEdge(text, "right") ?? "") ? { count: 0, wordEdge: false } : null;
    }

    if (isCustomRendered(sibling, lookup, options)) {
        return { count: 0, wordEdge: true };
    }

    const edge = edgeCharacter(sibling, side, options, lookup);

    return edge === null ? null : { count: 0, wordEdge: WORD_CHARACTER.test(edge) };
}

/**
 * The line breaks between a node and its neighbour on one side, or infinity when
 * whitespace lies there, which keeps the two apart whatever comes next.
 */
function separation(node: AnnotatedNode, side: Side): number {
    return flankOf(node, side) === "" ? edgeBreaks(node, side) : Infinity;
}

const BUILTIN_RULES = new Set<Rule>(Object.values(rules));

/** True when a rule that is not one of the built-in rules renders the node, so its output is not known from the DOM. */
function isCustomRendered(node: Node, lookup: RuleLookup, options: Options): boolean {
    const rule = lookup.ruleFor(node);

    // A blank element goes through the blank rule whatever its filter says, so its output is known from the DOM.
    return rule !== undefined && !BUILTIN_RULES.has(rule) && !annotationOf(node, options).isBlank;
}

/** The built-in rule that renders a run's elements. Only its output writes the run's delimiters. */
function builtinRunRule(names: ReadonlySet<string>): Rule | undefined {
    return names === EMPHASIS_NAMES ? rules.emphasis : rules.strong;
}

/**
 * True for an element of the same kind that can share a run with this one. It must be rendered by the
 * built-in rule, so the run's delimiters are its own, and it must print something: an element with
 * nothing to print (an image with no source, a word-break hint) would write no delimiter while its
 * neighbour left its own out.
 */
function isRunMember(node: Node, names: ReadonlySet<string>, options: Options, lookup: RuleLookup): boolean {
    if (node.nodeType !== 1 || !names.has(node.nodeName.toLowerCase())) {
        return false;
    }

    if (lookup.ruleFor(node) !== builtinRunRule(names) || annotationOf(node, options).isBlank) {
        return false;
    }

    return !hasOnlyBreaks(node) && !hasBlockDescendant(node) && childEdge(node as Element, "left", options, lookup) !== null;
}

/**
 * True when a same-kind parent that the built-in rule renders writes the delimiters for the whole run, so
 * a nested element writes none. A parent with a block (even a blank one, which prints a break) never shares
 * its delimiters, and a parent that a custom rule renders writes no delimiters of its own.
 */
function hasSharingParent(parent: Node | null, style: RunStyle, options: Options, lookup: RuleLookup): boolean {
    if (!parent || !style.names.has(parent.nodeName.toLowerCase())) {
        return false;
    }

    return lookup.ruleFor(parent) === builtinRunRule(style.names) && !hasPrintingBlockDescendant(parent, options);
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

/**
 * The text of a heading. A heading is one line, so a hard break in it becomes a space. Its breaks are written as
 * a mark (see headingBreakMark) rather than the break marker, so neither block separators nor text that looks
 * like a marker (a code line ending in two spaces) is taken for a break.
 */
function headingText(content: string, node: AnnotatedNode, lookup: RuleLookup): string {
    const mark = headingMarkOf(node, lookup);

    // The block's own separators at either end are not heading text, so the underline is not sized to them.
    // A custom break rule writes no mark, so a heading whose content holds none is written as is.
    return mark === undefined || !content.includes(mark) ? content : trimNewlines(joinAtMarks(content, mark).trim());
}

/**
 * The break mark of a heading that the built-in heading rule renders and that holds a break, otherwise
 * undefined. A custom heading rule never sees a mark: only the built-in rule turns it back into a space.
 */
function headingMarkOf(heading: Node, lookup: RuleLookup): string | undefined {
    // Each break asks for its heading's mark. The mark serialises and scans the whole heading, so it is computed once.
    if (headingMarks.has(heading)) {
        return headingMarks.get(heading);
    }

    // Truthiness, not `!== null`: domino returns undefined when nothing matches.
    const isMarked = lookup.ruleFor(heading) === rules.heading && Boolean((heading as Element).querySelector("br"));
    const mark = isMarked ? headingBreakMark(heading) : undefined;

    headingMarks.set(heading, mark);

    return mark;
}

/**
 * The break mark for a break in the node's heading, or undefined when the break is not in a marked heading.
 * Uses the heading's cached mark, so each break does not serialise the whole heading again.
 */
function breakMarkFor(node: Node, lookup: RuleLookup): string | undefined {
    for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
        if (HEADING_NAMES.has(ancestor.nodeName)) {
            return headingMarkOf(ancestor, lookup);
        }
    }

    return undefined;
}

// The Unicode private-use area, U+E000 to U+F8FF, written as escapes so no editor can strip the characters.
const PRIVATE_USE_START = "\u{E000}".codePointAt(0) ?? 0;
const PRIVATE_USE_END = "\u{F8FF}".codePointAt(0) ?? 0;
// A break mark is this many private-use characters, and at most this many candidates are tried.
const MARK_LENGTH = 8;
const MARK_CANDIDATES = 16;

/**
 * A mark that the heading's markup does not contain. A break in the heading is written as this mark, so text of
 * the heading is never taken for a break. The mark is a run of private-use characters, long enough that neither
 * the markup nor a custom rule's output holds the same run by chance.
 */
function headingBreakMark(heading: Node): string {
    const markup = (heading as Element).outerHTML ?? "";

    // Untrusted markup can hold every candidate (they share one step), so only a bounded number are tried.
    for (let candidate = 0; candidate < MARK_CANDIDATES; candidate += 1) {
        const mark = markCandidate(candidate);

        if (!markup.includes(mark)) {
            return mark;
        }
    }

    return repeatedMark(markup);
}

/**
 * A mark absent from the markup by construction: the first private-use character, repeated once more than its
 * longest run in the markup and never shorter than a candidate. One pass over the markup, so it always ends.
 */
function repeatedMark(markup: string): string {
    const first = String.fromCodePoint(PRIVATE_USE_START);
    let longest = 0;
    let current = 0;

    for (const character of markup) {
        current = character === first ? current + 1 : 0;
        longest = Math.max(longest, current);
    }

    return first.repeat(Math.max(MARK_LENGTH, longest + 1));
}

/**
 * The candidate mark with the given number: a run of private-use characters spread across the area by two large
 * primes, so no candidate is a natural run such as one character repeated. The same number gives the same mark.
 */
function markCandidate(candidate: number): string {
    const span = PRIVATE_USE_END - PRIVATE_USE_START + 1;
    let mark = "";

    for (let index = 0; index < MARK_LENGTH; index += 1) {
        mark += String.fromCodePoint(PRIVATE_USE_START + ((candidate * 7919 + (index + 1) * 104_729) % span));
    }

    return mark;
}

/** Writes each mark as a space, dropping the spaces beside it. A piece that starts a new line takes no space. */
function joinAtMarks(content: string, mark: string): string {
    const [first = "", ...rest] = content.split(mark);
    const pieces: string[] = [];
    let carried = first;

    // Only the piece just before a mark can end in a space, so only that piece is trimmed. Trimming the whole text
    // each time would rescan everything written so far.
    for (const piece of rest) {
        // Marks with only spaces between them (two breaks in a row) write one space, not one each.
        if (piece.trim() === "" && !piece.includes("\n")) {
            continue;
        }

        const before = carried.replace(TRAILING_SPACE, "");

        // A block's paragraph break on either side of the mark already separates the text, so no space is added.
        pieces.push(before, piece.startsWith("\n") || before.endsWith("\n") ? "" : " ");
        carried = piece.replace(LEADING_SPACE, "");
    }

    pieces.push(carried);

    return pieces.join("");
}

/**
 * A link's text in a heading, split into the break marks at its edges and the text between. The edge marks go
 * outside the link's brackets, where the heading turns them into spaces between words, not spaces in the link.
 */
function headingLinkParts(content: string, mark: string | undefined): { lead: string; text: string; trail: string } {
    if (mark === undefined) {
        return { lead: "", text: content, trail: "" };
    }

    let start = 0;
    let end = content.length;

    while (content.startsWith(mark, start)) {
        start += mark.length;
    }

    while (end - mark.length >= start && content.startsWith(mark, end - mark.length)) {
        end -= mark.length;
    }

    return { lead: content.slice(0, start), text: content.slice(start, end), trail: content.slice(end) };
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
function edgeCharacter(node: Node, side: Side, options: Options, lookup: RuleLookup): string | null {
    // A CDATA section (type 4) prints its text, as a text node does.
    if (node.nodeType === 3 || node.nodeType === 4) {
        return textEdge(node.nodeValue ?? "", side);
    }

    if (node.nodeType !== 1) {
        return null;
    }

    // A removed element prints none of its text, so an element holding only that prints nothing and is no run member.
    if (lookup.ruleFor(node)?.replacement === removeReplacement) {
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

        // A nested same-kind element whose parent writes the delimiters prints none, so its edge is its text.
        return isDelimitedByParent(element, options, lookup) ? childEdge(element, side, options, lookup) : "";
    }

    return childEdge(element, side, options, lookup);
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
function childEdge(element: Element, side: Side, options: Options, lookup: RuleLookup): string | null {
    let child = side === "left" ? element.lastChild : element.firstChild;

    while (child) {
        const edge = edgeCharacter(child, side, options, lookup);

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

/**
 * The next node on one side, climbing out of transparent wrappers (see isTransparentWrapper) at their edge. A
 * wrapper with whitespace at that edge ends the walk: the space keeps the run apart from what follows.
 */
function neighbourThroughWrappers(node: Node, side: Side, options: Options, lookup: RuleLookup): Node | null {
    let current = node;
    let next = neighbour(current, side);

    while (!next) {
        const parent = current.parentNode;

        if (!parent || !isTransparentWrapper(parent, options, lookup) || flankOf(annotationOf(parent, options), side) !== "") {
            return null;
        }

        current = parent;
        next = neighbour(current, side);
    }

    return next;
}

/** The child a walk steps into when it meets a transparent wrapper with no whitespace on the facing edge, else null. */
function wrapperEntry(node: Node, side: Side, options: Options, lookup: RuleLookup): Node | null {
    if (!isTransparentWrapper(node, options, lookup) || flankOf(annotationOf(node, options), opposite(side)) !== "") {
        return null;
    }

    return side === "left" ? node.lastChild : node.firstChild;
}

/**
 * True for an inline element that prints its content as is: no rule claims it and the default replacement writes
 * it (a span, or an anchor that renders no link). Its text sits directly beside its neighbours in the output.
 */
function isTransparentWrapper(node: Node, options: Options, lookup: RuleLookup): boolean {
    if (node.nodeType !== 1 || isBlock(node) || isVoid(node) || options.defaultReplacement !== defaultElementReplacement) {
        return false;
    }

    const name = node.nodeName.toLowerCase();

    if (DELIMITED_NAMES.has(name) && (name !== "a" || isRenderedLink(node as Element, options))) {
        return false;
    }

    return lookup.ruleFor(node) === undefined && !annotationOf(node, options).isBlank;
}

/** True for an emphasis or strong element nested in a same-kind parent that writes the delimiters for both. */
function isDelimitedByParent(element: Element, options: Options, lookup: RuleLookup): boolean {
    const name = element.nodeName.toLowerCase();
    const names = EMPHASIS_NAMES.has(name) ? EMPHASIS_NAMES : STRONG_NAMES;

    if (!names.has(name) || lookup.ruleFor(element) !== builtinRunRule(names)) {
        return false;
    }

    return hasSharingParent(element.parentNode, { intraword: "", names, plain: "" }, options, lookup);
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
 * With `safeLinks`, `\` and `&` are escaped too. CommonMark undoes those added escapes, so the rendered destination is
 * the raw attribute, not the decoded copy. The check already covers the raw attribute: `isUnsafeDestination` runs on a
 * decoded copy of that same text. Line breaks are dropped first, as a browser drops them from an `href`, so the
 * destination stays on one line and cannot start a reference definition.
 */
function escapeLinkDestination(destination: string, isSafeLinks = false): string {
    const oneLine = destination.replaceAll(LINE_BREAKS, "");
    const escaped = (isSafeLinks ? oneLine.replaceAll("\\", "\\\\").replaceAll("&", "&amp;") : oneLine)
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

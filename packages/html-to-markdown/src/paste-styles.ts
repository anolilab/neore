/**
 * Formatting set by style, for the paste preset. Google Docs and Word write bold, italics and strikethrough as styles on
 * spans and blocks, not as `<b>`, `<i>` or `<s>`, and set text inside bold back to normal weight with a style too.
 *
 * Text set back to normal weight inside bold stays out of the bold's `**`. Its rule marks the text with two control
 * characters, and the bold element around it wraps the runs between the marks apart. The marks are taken out of the
 * input first, so only the preset writes them, and out of the output at the end.
 */
import { escapeTildes } from "./gfm";
import { declaredStyle } from "./inline-style";
import type TurndownService from "./turndown";
import type { TurndownInput } from "./turndown";
import type { Rule, RuleLookup } from "./types";

const NORMAL_START = "\u{1}";
const NORMAL_END = "\u{2}";
const BOLD_WEIGHTS = new Set(["600", "700", "800", "900", "bold", "bolder"]);

// `lighter` is not here: it is relative, and under a heavy weight it is still bold.
export const NORMAL_WEIGHTS = new Set(["100", "200", "300", "400", "normal"]);

const BOLD_NAMES = new Set(["B", "STRONG"]);
const ITALIC_NAMES = new Set(["EM", "I"]);
const STRIKE_NAMES = new Set(["DEL", "S", "STRIKE"]);
// The elements whose style sets their text's formatting. A heading is bold already, and code keeps its text as it is.
const STYLED = new Set(["A", "DD", "DIV", "DT", "FONT", "LI", "P", "SPAN", "TD", "TH"]);
// Blocks emphasis cannot span: an element holding one is written without its own formatting.
const JOINER = "\u{200D}";
// What a ZWJ emoji sequence joins: a pictograph, its emoji selector or a skin tone.
const EMOJI_EDGE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]$/u;
// What a paste starts with that is no content: blank lines and the spaces before the first text. A non-breaking space
// the page shows is kept.
const LEADING_SPACE = /^[\t\n\r ]+/;
const STRUCTURE = new Set(["BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "OL", "PRE", "TABLE", "UL"]);

/** The formatting an element gives its text, by its name or its style. */
interface Emphasis {
    isBold: boolean;
    isItalic: boolean;
    /** Set back to normal weight. */
    isNormal: boolean;
    isStrike: boolean;
}

const emphases = new WeakMap<Element, Emphasis>();

function emphasisOf(element: Element): Emphasis {
    const cached = emphases.get(element);

    if (cached) {
        return cached;
    }

    const name = element.nodeName;
    const style = element.getAttribute("style") ?? "";
    const isStyled = STYLED.has(name);
    const weight = style === "" ? "" : declaredStyle(style, "font-weight");
    const isNormal = (isStyled || BOLD_NAMES.has(name)) && NORMAL_WEIGHTS.has(weight);
    const emphasis: Emphasis = {
        isBold: !isNormal && (BOLD_NAMES.has(name) || (isStyled && BOLD_WEIGHTS.has(weight))),
        isItalic: ITALIC_NAMES.has(name) || (isStyled && style !== "" && isItalicStyle(style)),
        isNormal,
        isStrike: STRIKE_NAMES.has(name) || (isStyled && style !== "" && isStruckStyle(style)),
    };

    emphases.set(element, emphasis);

    return emphasis;
}

function isItalicStyle(style: string): boolean {
    const value = declaredStyle(style, "font-style");

    return value === "italic" || value.startsWith("oblique");
}

function isStruckStyle(style: string): boolean {
    return ["text-decoration", "text-decoration-line"].some((property) => declaredStyle(style, property).split(" ").includes("line-through"));
}

function isNamed(element: Element): boolean {
    return BOLD_NAMES.has(element.nodeName) || ITALIC_NAMES.has(element.nodeName) || STRIKE_NAMES.has(element.nodeName);
}

const decidingElements = new WeakMap<Node, Element | null>();

/** The nearest element from `start` up that sets the weight, bold or normal, or null. Each element is asked once. */
function nearestWeight(start: Node | null): Element | null {
    const chain: Node[] = [];
    let current = start;
    let found: Element | null = null;

    while (current?.nodeType === 1) {
        const known = decidingElements.get(current);

        if (known !== undefined) {
            found = known;
            break;
        }

        chain.push(current);

        const emphasis = emphasisOf(current as Element);

        if (emphasis.isBold || emphasis.isNormal) {
            found = current as Element;
            break;
        }

        current = current.parentNode;
    }

    for (const node of chain) {
        decidingElements.set(node, found);
    }

    return found;
}

/** True for an element set back to normal weight inside bold. */
function isUnbold(element: Element): boolean {
    const weight = element.parentNode ? nearestWeight(element.parentNode) : null;

    return emphasisOf(element).isNormal && weight !== null && emphasisOf(weight).isBold;
}

const tops = new WeakMap<Node, Node>();

/** The top of the tree the node is in: the conversion's document or copy. */
function topOf(node: Node): Node {
    const chain: Node[] = [];
    let current = node;

    while (current.parentNode && !tops.has(current)) {
        chain.push(current);
        current = current.parentNode;
    }

    const top = tops.get(current) ?? current;

    for (const member of chain) {
        tops.set(member, top);
    }

    return top;
}

const carriersByTop = new WeakMap<Node, Set<Element>>();

/**
 * The elements a normal-weight run's marks pass through: the bold element around each run and the formatting elements
 * between the two. Their rule must read the marks, so the preset writes them, not the built-in emphasis rules. Found
 * once per conversion, from the elements with a style.
 */
function carriersOf(node: Node): Set<Element> {
    const top = topOf(node);
    let carriers = carriersByTop.get(top);

    if (carriers) {
        return carriers;
    }

    carriers = new Set();

    const found = (top as ParentNode).querySelectorAll?.("[style]");

    for (let index = 0; index < (found?.length ?? 0); index += 1) {
        const element = found?.[index] as Element;

        if (!isUnbold(element)) {
            continue;
        }

        addCarriers(element, carriers);
    }

    carriersByTop.set(top, carriers);

    return carriers;
}

/**
 * Adds the elements from the run up to the bold element around it. None between sets the weight, and one added already
 * was reached from another run, with the rest of the way added then.
 */
function addCarriers(run: Element, carriers: Set<Element>): void {
    for (let above = run.parentNode; above?.nodeType === 1 && !carriers.has(above as Element); above = above.parentNode) {
        carriers.add(above as Element);

        if (emphasisOf(above as Element).isBold) {
            return;
        }
    }
}

/** A step of the walk that finds structure: an element, before or after its children. */
interface StructureStep {
    element: Element;
    isDone: boolean;
}

const structures = new WeakMap<Element, boolean>();

/** True when the element holds a block emphasis cannot span, such as a list or a table. Each element is read once. */
function hasStructure(root: Element, lookup: RuleLookup): boolean {
    const known = structures.get(root);

    if (known !== undefined) {
        return known;
    }

    // Children before parents: an element holds structure when a child is one or holds one.
    const pending: StructureStep[] = [{ element: root, isDone: false }];

    while (pending.length > 0) {
        const { element, isDone } = pending.pop() as StructureStep;

        if (isDone) {
            let isFound = false;

            for (let child = element.firstElementChild; child && !isFound; child = child.nextElementSibling) {
                // A hidden list is not written, so it parts nothing.
                isFound = !lookup.isRemoved(child) && (STRUCTURE.has(child.nodeName) || structures.get(child) === true);
            }

            structures.set(element, isFound);
            continue;
        }

        pending.push({ element, isDone: true });

        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
            if (!structures.has(child) && !lookup.isRemoved(child)) {
                pending.push({ element: child, isDone: false });
            }
        }
    }

    return structures.get(root) === true;
}

const firstTexts = new WeakMap<Node, string>();
const lastTexts = new WeakMap<Node, string>();

/**
 * The text at one edge of the node: its first (or last) descendant's, or "". Remembered for each node on the way down,
 * so nested formatting reads each edge once.
 */
function edgeText(node: Node | null, side: "first" | "last"): string {
    const known = side === "first" ? firstTexts : lastTexts;
    const chain: Node[] = [];
    let current = node;
    let text = "";

    while (current) {
        const cached = known.get(current);

        if (cached !== undefined) {
            text = cached;
            break;
        }

        if (current.nodeType === 3) {
            text = current.nodeValue ?? "";
            break;
        }

        chain.push(current);
        current = edgeChild(current, side);
    }

    for (const member of chain) {
        known.set(member, text);
    }

    return text;
}

function edgeChild(node: Node, side: "first" | "last"): Node | null {
    if (node.nodeType !== 1) {
        return null;
    }

    return side === "first" ? node.firstChild : node.lastChild;
}

/** The last character of the text, a whole code point: its last two code units are one when they are a surrogate pair. */
function lastCodePoint(text: string): string {
    return [...text.slice(-2)].at(-1) ?? "";
}

/**
 * True when the element's edge falls inside a ZWJ emoji sequence (`<b>👩</b>‍👩`). A delimiter there parts the joiner
 * from an emoji and breaks the sequence; formatting shows nothing on an emoji anyway, so it is left unmarked.
 */
function isInEmojiSequence(element: Element): boolean {
    const first = edgeText(element, "first");
    const last = edgeText(element, "last");

    if (first.trimStart().startsWith(JOINER) || last.trimEnd().endsWith(JOINER)) {
        return true;
    }

    const isJoinedAfter = EMOJI_EDGE.test(lastCodePoint(last)) && edgeText(element.nextSibling, "first").startsWith(JOINER);
    const isJoinedBefore = EMOJI_EDGE.test(String.fromCodePoint(first.codePointAt(0) ?? 0)) && edgeText(element.previousSibling, "last").endsWith(JOINER);

    return isJoinedAfter || isJoinedBefore;
}

export function withoutMarks(text: string): string {
    return text.includes(NORMAL_START) || text.includes(NORMAL_END) ? text.replaceAll(NORMAL_START, "").replaceAll(NORMAL_END, "") : text;
}

/** `marker` around the text, with the whitespace at its ends kept outside, where Markdown lets a delimiter be. */
function wrapEdges(text: string, marker: string): string {
    const core = text.trim();

    if (core === "") {
        return text;
    }

    const start = text.length - text.trimStart().length;

    return `${text.slice(0, start)}${marker}${core}${marker}${text.slice(start + core.length)}`;
}

/**
 * `marker` around each run of the content between normal-weight marks, paragraph by paragraph: emphasis cannot span a
 * blank line. A normal-weight run that goes on past one is closed before it and opened again after it.
 */
function wrapRuns(content: string, marker: string, isBold: boolean): string {
    if (!content.includes("\n\n")) {
        return wrapParagraph(content, marker, isBold);
    }

    let isOpen = false;

    return content
        .split("\n\n")
        .map((piece) => {
            const opened = isOpen ? `${NORMAL_START}${piece}` : piece;

            isOpen = opened.lastIndexOf(NORMAL_START) > opened.lastIndexOf(NORMAL_END);

            return wrapParagraph(isOpen ? `${opened}${NORMAL_END}` : opened, marker, isBold);
        })
        .join("\n\n");
}

/**
 * `marker` around each run of one paragraph between normal-weight marks. Bold leaves a marked run as it is and drops its
 * marks; italics and strikethrough go inside the marks as well, so the bold around them never splits a delimiter.
 */
function wrapParagraph(content: string, marker: string, isBold: boolean): string {
    const parts: string[] = [];
    let from = 0;

    for (let start = content.indexOf(NORMAL_START); start !== -1; start = content.indexOf(NORMAL_START, from)) {
        const end = content.indexOf(NORMAL_END, start);
        const normalEnd = end === -1 ? content.length : end;
        const normal = content.slice(start + 1, normalEnd);

        parts.push(wrapEdges(content.slice(from, start), marker), isBold ? normal : `${NORMAL_START}${wrapEdges(normal, marker)}${NORMAL_END}`);
        from = normalEnd + 1;
    }

    parts.push(wrapEdges(content.slice(from), marker));

    return parts.join("");
}

type Kind = "isBold" | "isItalic" | "isStrike";

const KINDS: ReadonlyArray<Kind> = ["isBold", "isItalic", "isStrike"];

const formattedBy: Record<Kind, WeakMap<Node, Element | null>> = { isBold: new WeakMap(), isItalic: new WeakMap(), isStrike: new WeakMap() };

function hasKind(emphasis: Emphasis, kind: Kind): boolean {
    switch (kind) {
        case "isBold": {
            return emphasis.isBold;
        }
        case "isItalic": {
            return emphasis.isItalic;
        }
        default: {
            return emphasis.isStrike;
        }
    }
}

/**
 * The nearest element from `start` up that gives its text this formatting, or null. For bold, the nearest element that
 * sets the weight decides, so text set back to normal weight inside bold is not under it. Each element is asked once.
 */
function formattingFrom(start: Node | null, kind: Kind): Element | null {
    if (kind === "isBold") {
        const weight = nearestWeight(start);

        return weight !== null && emphasisOf(weight).isBold ? weight : null;
    }

    const known = formattedBy[kind];
    const chain: Node[] = [];
    let current = start;
    let found: Element | null = null;

    while (current?.nodeType === 1) {
        const cached = known.get(current);

        if (cached !== undefined) {
            found = cached;
            break;
        }

        chain.push(current);

        if (hasKind(emphasisOf(current as Element), kind)) {
            found = current as Element;
            break;
        }

        current = current.parentNode;
    }

    for (const member of chain) {
        known.set(member, found);
    }

    return found;
}

/** True when the preset may write the element's own formatting: no block it cannot span, no split emoji sequence. */
function canWrap(element: Element, lookup: RuleLookup): boolean {
    return !hasStructure(element, lookup) && !isInEmojiSequence(element);
}

/**
 * True when an element around this one writes this formatting already: `<b>`, `<i>` or `<s>`, or a styled element
 * that can write it. A styled block holding a list writes none, so the formatting inside it writes its own.
 */
function isFormattedAbove(element: Element, kind: Kind, lookup: RuleLookup): boolean {
    const above = formattingFrom(element.parentNode, kind);

    return above !== null && (isNamed(above) || canWrap(above, lookup));
}

/**
 * True for `<b>`, `<i>` or `<s>` inside a styled element with the same formatting: the styled element writes the one
 * pair of delimiters, so the preset writes this one, without any.
 */
function isNestedInStyled(element: Element, lookup: RuleLookup): boolean {
    const emphasis = emphasisOf(element);

    return KINDS.some((kind) => {
        const above = hasKind(emphasis, kind) ? formattingFrom(element.parentNode, kind) : null;

        return above !== null && !isNamed(above) && canWrap(above, lookup);
    });
}

// Bold, italics and strikethrough set by a style, and text set back to normal weight inside bold. A styled block passes
// its formatted text on to the rule that writes the block: a paragraph, a list item, a table cell.
const styledText: Rule = {
    filter: (node, _options, lookup) => {
        if (lookup.isRemoved(node)) {
            return false;
        }

        if (isNamed(node)) {
            return isUnbold(node) || carriersOf(node).has(node) || isInEmojiSequence(node) || isNestedInStyled(node, lookup);
        }

        const emphasis = emphasisOf(node);

        return STYLED.has(node.nodeName) && (emphasis.isBold || emphasis.isItalic || emphasis.isStrike || isUnbold(node));
    },
    replacement(content, node, options, lookup) {
        const emphasis = emphasisOf(node);
        const isWrapped = canWrap(node, lookup);
        let text = content;

        if (emphasis.isBold) {
            // Bold inside bold writes no second pair; the marks wait for the bold around it.
            if (!isFormattedAbove(node, "isBold", lookup)) {
                text = isWrapped ? wrapRuns(text, options.strongDelimiter, true) : withoutMarks(text);
            }
        } else if (isUnbold(node) && text.trim() !== "") {
            // All of it is normal weight, so marks inside it are not needed.
            text = `${NORMAL_START}${withoutMarks(text)}${NORMAL_END}`;
        }

        if (isWrapped && emphasis.isItalic && !isFormattedAbove(node, "isItalic", lookup)) {
            text = wrapRuns(text, options.emDelimiter, false);
        }

        if (isWrapped && emphasis.isStrike && !isFormattedAbove(node, "isStrike", lookup)) {
            text = wrapRuns(escapeTildes(text), "~~", false);
        }

        if (isNamed(node)) {
            return text;
        }

        const next = lookup.ruleAfter(styledText, node);

        return next.replacement.call(next, text, node, options, lookup);
    },
};

export const styleRules: Record<string, Rule> = { styledText };

/** The element's attributes, copied by index: domino's NamedNodeMap is not iterable. */
function attributesOf(element: Element): Attr[] {
    const { attributes } = element;

    return Array.from({ length: attributes.length }, (_unused, index) => attributes[index] as Attr);
}

/** True when the node's text or an attribute in it holds a mark. */
function hasMarks(root: Node): boolean {
    const pending: Node[] = [root];

    while (pending.length > 0) {
        const node = pending.pop() as Node;

        if ((node.nodeType === 3 || node.nodeType === 8) && withoutMarks(node.nodeValue ?? "") !== node.nodeValue) {
            return true;
        }

        if (node.nodeType === 1 && attributesOf(node as Element).some(({ value }) => withoutMarks(value) !== value)) {
            return true;
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
            pending.push(child);
        }
    }

    return false;
}

/** A copy of the node with the marks taken out of its text and attributes. */
function copyWithoutMarks(input: Node): Node {
    const copy = input.cloneNode(true);
    const pending: Node[] = [copy];

    while (pending.length > 0) {
        const node = pending.pop() as Node;

        if (node.nodeType === 3 || node.nodeType === 8) {
            node.nodeValue = withoutMarks(node.nodeValue ?? "");
        } else if (node.nodeType === 1) {
            for (const attribute of attributesOf(node as Element)) {
                attribute.value = withoutMarks(attribute.value);
            }
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
            pending.push(child);
        }
    }

    return copy;
}

/**
 * Takes the marks out of what is converted, so only the preset writes them, and out of what it gives back. The output
 * also loses the blank text before its first content, such as the spaces between the elements of a pasted `<head>`.
 */
export function guardMarks(service: TurndownService): void {
    const convert = service.turndown.bind(service);
    const finish = (markdown: string): string => withoutMarks(markdown).replace(LEADING_SPACE, "");

    const turndown = (input: TurndownInput): string => {
        if (typeof input === "string") {
            return finish(convert(withoutMarks(input)));
        }

        const isNode = typeof input === "object" && input !== null && typeof (input as Partial<Node>).nodeType === "number";

        return finish(convert(isNode && hasMarks(input) ? copyWithoutMarks(input) : input));
    };

    Object.assign(service, { turndown });
}

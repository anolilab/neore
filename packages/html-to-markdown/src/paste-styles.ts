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
import { checkDepth } from "./paste-input";
import { LINE_BREAK_MARK } from "./paste-lists";
import { parseRoot } from "./root-node";
import type TurndownService from "./turndown";
import type { TurndownInput } from "./turndown";
import type { Options, Rule, RuleLookup } from "./types";
import { isBlock } from "./utilities";

// Text, CDATA and comments: the nodes whose text the marks are taken out of.
const TEXT_TYPES = new Set([3, 4, 8]);
const NORMAL_START = "\u{1}";
const NORMAL_END = "\u{2}";

/** The marks a style rule writes for its delimiters, put in at the end: a closer right before an opener of its kind goes. */
interface Delimiter {
    close: string;
    open: string;
}

const STRONG: Delimiter = { close: "\u{4}", open: "\u{3}" };
const EMPHASIS: Delimiter = { close: "\u{6}", open: "\u{5}" };
const STRIKE: Delimiter = { close: "\u{F}", open: "\u{E}" };

// Every mark the preset writes, taken out of the input so only the preset writes them.
const ALL_MARKS = [NORMAL_START, NORMAL_END, STRONG.open, STRONG.close, EMPHASIS.open, EMPHASIS.close, STRIKE.open, STRIKE.close, LINE_BREAK_MARK];
const BOLD_WEIGHTS = new Set(["600", "700", "800", "900", "bold", "bolder"]);

// `lighter` is not here: it is relative, and under a heavy weight it is still bold.
// Up to 500, medium, which is not bold either.
const NORMAL_WEIGHTS = new Set(["100", "200", "300", "400", "500", "normal"]);
// The whitespace between the keywords of a CSS value.
const CSS_SPACE = /[\t\n\f\r ]+/;
// The box the gfm rules write for a checkbox at the start of a list item.
const TASK_BOX = /^\[[ x]\] /;
const GLOBAL_VALUES = new Set(["inherit", "initial", "revert", "revert-layer", "unset"]);
const NUMBER = /^\d+(?:\.\d+)?$/;
const MAX_WEIGHT = 1000;
// `inherit` and `unset` take the parent's weight; `revert` goes back to the browser's own style, bolder for `<b>`.
const INHERITING = new Set(["inherit", "unset"]);
const REVERTING = new Set(["revert", "revert-layer"]);
const DEFAULT_WEIGHT = 400;
const BOLD_WEIGHT = 700;
// A weight from 600 up shows as bold.
const MIN_BOLD = 600;
// The functions a decoration's color or thickness may be written with.
const VALUE_FUNCTIONS = new Set(["calc", "color", "color-mix", "hsl", "hsla", "hwb", "lab", "lch", "light-dark", "oklab", "oklch", "rgb", "rgba", "var"]);
const LINE_KEYWORDS = new Set(["blink", "line-through", "none", "overline", "underline"]);
// What else the `text-decoration` shorthand takes: a line style, a thickness and a color.
const DECORATION_STYLES = new Set(["dashed", "dotted", "double", "solid", "wavy"]);
const THICKNESS_KEYWORDS = new Set(["auto", "from-font"]);
// A length or a percentage: `2px`, `.5em`, `10%`.
const LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)(?:%|[a-z]{1,4})?$/;
const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/;
// The named colors of CSS Color 4, and the two keywords a color may also be.
const NAMED_COLORS = new Set([
    "aliceblue",
    "antiquewhite",
    "aqua",
    "aquamarine",
    "azure",
    "beige",
    "bisque",
    "black",
    "blanchedalmond",
    "blue",
    "blueviolet",
    "brown",
    "burlywood",
    "cadetblue",
    "chartreuse",
    "chocolate",
    "coral",
    "cornflowerblue",
    "cornsilk",
    "crimson",
    "currentcolor",
    "cyan",
    "darkblue",
    "darkcyan",
    "darkgoldenrod",
    "darkgray",
    "darkgreen",
    "darkgrey",
    "darkkhaki",
    "darkmagenta",
    "darkolivegreen",
    "darkorange",
    "darkorchid",
    "darkred",
    "darksalmon",
    "darkseagreen",
    "darkslateblue",
    "darkslategray",
    "darkslategrey",
    "darkturquoise",
    "darkviolet",
    "deeppink",
    "deepskyblue",
    "dimgray",
    "dimgrey",
    "dodgerblue",
    "firebrick",
    "floralwhite",
    "forestgreen",
    "fuchsia",
    "gainsboro",
    "ghostwhite",
    "gold",
    "goldenrod",
    "gray",
    "green",
    "greenyellow",
    "grey",
    "honeydew",
    "hotpink",
    "indianred",
    "indigo",
    "ivory",
    "khaki",
    "lavender",
    "lavenderblush",
    "lawngreen",
    "lemonchiffon",
    "lightblue",
    "lightcoral",
    "lightcyan",
    "lightgoldenrodyellow",
    "lightgray",
    "lightgreen",
    "lightgrey",
    "lightpink",
    "lightsalmon",
    "lightseagreen",
    "lightskyblue",
    "lightslategray",
    "lightslategrey",
    "lightsteelblue",
    "lightyellow",
    "lime",
    "limegreen",
    "linen",
    "magenta",
    "maroon",
    "mediumaquamarine",
    "mediumblue",
    "mediumorchid",
    "mediumpurple",
    "mediumseagreen",
    "mediumslateblue",
    "mediumspringgreen",
    "mediumturquoise",
    "mediumvioletred",
    "midnightblue",
    "mintcream",
    "mistyrose",
    "moccasin",
    "navajowhite",
    "navy",
    "oldlace",
    "olive",
    "olivedrab",
    "orange",
    "orangered",
    "orchid",
    "palegoldenrod",
    "palegreen",
    "paleturquoise",
    "palevioletred",
    "papayawhip",
    "peachpuff",
    "peru",
    "pink",
    "plum",
    "powderblue",
    "purple",
    "rebeccapurple",
    "red",
    "rosybrown",
    "royalblue",
    "saddlebrown",
    "salmon",
    "sandybrown",
    "seagreen",
    "seashell",
    "sienna",
    "silver",
    "skyblue",
    "slateblue",
    "slategray",
    "slategrey",
    "snow",
    "springgreen",
    "steelblue",
    "tan",
    "teal",
    "thistle",
    "tomato",
    "transparent",
    "turquoise",
    "violet",
    "wheat",
    "white",
    "whitesmoke",
    "yellow",
    "yellowgreen",
]);
// An angle, as `oblique` may take: `10deg`, `-0.5turn`.
const ANGLE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|grad|rad|turn)$/;

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
// A blank line, which may hold a line break's mark, kept as the separator when content is split on it.
// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- U+0010 is the preset's own line break mark.
const BLANK_LINE = /(\n\u{10}?\n)/u;
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
    // The element sets the weight when it declares one, or is `<b>`/`<strong>`, which a browser makes bolder.
    const isSet = declaredWeight(element) !== "" || BOLD_NAMES.has(name);
    const isHeavy = computedWeight(element) >= MIN_BOLD;
    const isNormal = (isStyled || isNamed(element)) && isSet && !isHeavy;
    const emphasis: Emphasis = {
        isBold: (BOLD_NAMES.has(name) || isStyled) && isSet && isHeavy,
        isItalic: ITALIC_NAMES.has(name) || (isStyled && style !== "" && isItalicStyle(style)),
        isNormal,
        isStrike: STRIKE_NAMES.has(name) || (isStyled && style !== "" && isStruckStyle(style)),
    };

    emphases.set(element, emphasis);

    return emphasis;
}

/** The weight the element declares, when its style sets its text's weight; "" when it takes its parent's. */
function declaredWeight(element: Element): string {
    const style = element.getAttribute("style") ?? "";

    if (style === "" || !(STYLED.has(element.nodeName) || isNamed(element))) {
        return "";
    }

    const value = declaredStyle(style, "font-weight", isWeightValue);

    return REVERTING.has(value) ? "" : value;
}

const weights = new WeakMap<Element, number>();

/** The weight the element's text shows with, as CSS computes it from the elements around it. Each is asked once. */
function computedWeight(element: Element): number {
    const chain: Element[] = [];
    let current: Element | null = element;
    let weight = DEFAULT_WEIGHT;

    while (current) {
        const known = weights.get(current);

        if (known !== undefined) {
            weight = known;
            break;
        }

        chain.push(current);
        current = current.parentElement;
    }

    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const member = chain[index] as Element;
        const declared = declaredWeight(member);

        // `inherit` keeps the parent's weight, even on `<b>`.
        if (declared !== "" && !INHERITING.has(declared)) {
            weight = resolvedWeight(declared, weight);
        } else if (declared === "" && BOLD_NAMES.has(member.nodeName)) {
            weight = bolder(weight);
        }

        weights.set(member, weight);
    }

    return weight;
}

/** A declared weight as a number, a relative one from the parent's. */
function resolvedWeight(value: string, parent: number): number {
    switch (value) {
        case "bold": {
            return BOLD_WEIGHT;
        }
        case "bolder": {
            return bolder(parent);
        }
        case "initial":
        case "normal": {
            return DEFAULT_WEIGHT;
        }
        case "lighter": {
            return lighter(parent);
        }
        default: {
            return Number(value);
        }
    }
}

// The steps CSS takes for `bolder` and `lighter`.
function bolder(weight: number): number {
    if (weight < 350) {
        return 400;
    }

    if (weight < 550) {
        return 700;
    }

    return Math.max(weight, 900);
}

function lighter(weight: number): number {
    if (weight < 100) {
        return weight;
    }

    if (weight < 550) {
        return 100;
    }

    return weight < 750 ? 400 : 700;
}

/** True for `<b>` or `<strong>` set back to normal weight, which is no bold. */
export function isSetToNormal(element: Element): boolean {
    return emphasisOf(element).isNormal;
}

/** True for a `font-weight` a browser reads: a keyword, a global value, or a number from 1 to 1000. */
function isWeightValue(value: string): boolean {
    if (value === "lighter" || NORMAL_WEIGHTS.has(value) || BOLD_WEIGHTS.has(value) || GLOBAL_VALUES.has(value)) {
        return true;
    }

    return NUMBER.test(value) && Number(value) >= 1 && Number(value) <= MAX_WEIGHT;
}

/** True for a `font-style` a browser reads: `oblique` alone or with an angle among them. */
function isFontStyleValue(value: string): boolean {
    const [keyword, angle, ...rest] = value.split(CSS_SPACE);

    if (keyword === "oblique") {
        return rest.length === 0 && (angle === undefined || ANGLE.test(angle));
    }

    return value === "italic" || value === "normal" || GLOBAL_VALUES.has(value);
}

/** True for a `text-decoration-line` a browser reads: line keywords, or a global value. */
function isDecorationLineValue(value: string): boolean {
    const keywords = value.split(CSS_SPACE);

    return GLOBAL_VALUES.has(value) || (keywords.every((keyword) => LINE_KEYWORDS.has(keyword)) && isLineList(keywords));
}

// A value a browser cannot read is dropped, so it overrides no earlier declaration.
function isItalicStyle(style: string): boolean {
    const value = declaredStyle(style, "font-style", isFontStyleValue);

    return value === "italic" || value.startsWith("oblique");
}

/** The keywords of a CSS value, split at whitespace outside parentheses, so `rgb(1 2 3)` is one. */
function cssTokens(value: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let depth = 0;

    for (const char of value) {
        depth = Math.max(0, depth + (char === "(" ? 1 : 0) - (char === ")" ? 1 : 0));

        if (depth === 0 && CSS_SPACE.test(char)) {
            if (current !== "") {
                tokens.push(current);
            }

            current = "";
        } else {
            current += char;
        }
    }

    return current === "" ? tokens : [...tokens, current];
}

/** True for a function a color or thickness is written with, such as `rgb(…)` or `calc(…)`, closed. */
function isFunctionToken(token: string): boolean {
    const open = token.indexOf("(");

    return open > 0 && token.endsWith(")") && VALUE_FUNCTIONS.has(token.slice(0, open));
}

/** True for a `text-decoration` shorthand a browser reads: each keyword a line, a line style, a thickness or a color. */
function isDecorationValue(value: string): boolean {
    if (GLOBAL_VALUES.has(value)) {
        return true;
    }

    const parts = cssTokens(value).map((keyword) => decorationPart(keyword));
    const lines = cssTokens(value).filter((_keyword, index) => parts[index] === "line");

    // One style, one thickness and one color at most; a `var()` may stand for any of them.
    const isOnceEach = (["style", "thickness", "color"] as const).every((part) => parts.filter((found) => found === part).length <= 1);

    return parts.every((part) => part !== undefined) && isOnceEach && (lines.length === 0 || isLineList(lines));
}

/** True for decoration line keywords CSS allows together: `none` alone, or each line once. */
function isLineList(keywords: ReadonlyArray<string>): boolean {
    if (keywords.includes("none")) {
        return keywords.length === 1;
    }

    return new Set(keywords).size === keywords.length;
}

type DecorationPart = "color" | "line" | "style" | "thickness" | "variable";

/** What a keyword of the shorthand sets: a line, a line style, a thickness or a color; undefined for none of them. */
function decorationPart(keyword: string): DecorationPart | undefined {
    if (LINE_KEYWORDS.has(keyword)) {
        return "line";
    }

    if (DECORATION_STYLES.has(keyword)) {
        return "style";
    }

    if (THICKNESS_KEYWORDS.has(keyword) || LENGTH.test(keyword) || keyword.startsWith("calc(")) {
        return isFunctionToken(keyword) || !keyword.includes("(") ? "thickness" : undefined;
    }

    if (keyword.startsWith("var(")) {
        return isFunctionToken(keyword) ? "variable" : undefined;
    }

    return NAMED_COLORS.has(keyword) || HEX_COLOR.test(keyword) || isFunctionToken(keyword) ? "color" : undefined;
}

/** True for a value the shorthand or the longhand that sets the decoration line takes. */
function isLineValue(value: string, property: string): boolean {
    return property === "text-decoration" ? isDecorationValue(value) : isDecorationLineValue(value);
}

/** True when the decoration line a style ends up with is struck: the shorthand and its longhand set it, the last one wins. */
function isStruckStyle(style: string): boolean {
    const line = declaredStyle(style, ["text-decoration", "text-decoration-line"], isLineValue);

    return line.split(CSS_SPACE).includes("line-through");
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

    return emphasisOf(element).isNormal && weight !== null && emphasisOf(weight).isBold && !isInCode(element);
}

const CODE_NAMES = new Set(["CODE", "KBD", "PRE", "SAMP", "TT"]);
const inCode = new WeakMap<Node, boolean>();

const HEADING_NAMES = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const inHeading = new WeakMap<Node, boolean>();

/** True for an element inside code, whose text is written as it is, with no formatting. Each element is asked once. */
function isInCode(element: Element): boolean {
    return hasAncestorIn(element, CODE_NAMES, inCode);
}

function isInHeading(element: Element): boolean {
    return hasAncestorIn(element, HEADING_NAMES, inHeading);
}

/** True when an element around this one has one of the names; the answer is remembered for each on the way up. */
function hasAncestorIn(element: Element, names: ReadonlySet<string>, known: WeakMap<Node, boolean>): boolean {
    const chain: Node[] = [];
    let current: Node | null = element.parentNode;
    let isFound = false;

    while (current?.nodeType === 1) {
        const cached = known.get(current);

        if (cached !== undefined) {
            isFound = cached;
            break;
        }

        chain.push(current);

        if (names.has(current.nodeName)) {
            isFound = true;
            break;
        }

        current = current.parentNode;
    }

    for (const member of chain) {
        known.set(member, isFound);
    }

    return isFound;
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
// Links that hold a normal-weight run inside bold.
const linkRuns = new WeakSet<Element>();

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

        // A link writes the bold inside its own label, as the marks must not reach into its syntax.
        if (above.nodeName === "A") {
            linkRuns.add(above as Element);
        }

        // A bold link is marked normal as a whole for the bold around it, if any, so the way goes on up to that one.
        const isBoldLink = above.nodeName === "A" && formattingFrom(above.parentNode, "isBold") !== null;

        if (!isBoldLink && emphasisOf(above as Element).isBold) {
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
function edgeText(node: Node | null, side: "first" | "last", lookup: RuleLookup): string {
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

        // Text, and CDATA, which a DOM passed in may hold.
        if (current.nodeType === 3 || current.nodeType === 4) {
            text = current.nodeValue ?? "";
            break;
        }

        chain.push(current);
        current = shownFrom(edgeChild(current, side), side, lookup);
    }

    for (const member of chain) {
        known.set(member, text);
    }

    return text;
}

/** The first sibling toward the edge that the page shows text in: hidden ones and empty elements are passed over. */
function textSibling(node: Node, side: "first" | "last", lookup: RuleLookup): Node | null {
    const step = (from: Node): Node | null => shownFrom(side === "first" ? from.nextSibling : from.previousSibling, side, lookup);
    let sibling = step(node);

    while (sibling?.nodeType === 1 && (sibling.textContent ?? "") === "") {
        sibling = step(sibling);
    }

    return sibling;
}

/** The node, or the first after it toward the edge (the next one for "first", the one before for "last") the page shows. */
function shownFrom(start: Node | null, side: "first" | "last", lookup: RuleLookup): Node | null {
    let node = start;

    while (node && (node.nodeType === 8 || (node.nodeType === 1 && lookup.isRemoved(node)))) {
        node = side === "first" ? node.nextSibling : node.previousSibling;
    }

    return node;
}

function edgeChild(node: Node, side: "first" | "last"): Node | null {
    if (node.nodeType !== 1) {
        return null;
    }

    return side === "first" ? node.firstChild : node.lastChild;
}

function isEmojiBefore(element: Element, lookup: RuleLookup): boolean {
    return EMOJI_EDGE.test(lastCodePoint(neighbourText(element, "last", lookup)));
}

function isEmojiAfter(element: Element, lookup: RuleLookup): boolean {
    return EMOJI_EDGE.test(firstCodePoint(neighbourText(element, "first", lookup)));
}

function firstCodePoint(text: string): string {
    return text === "" ? "" : String.fromCodePoint(text.codePointAt(0) ?? 0);
}

/** True for an emoji edge, or no text: the emoji may start in the next node. */
function isEmojiOrEmpty(character: string): boolean {
    return character === "" || EMOJI_EDGE.test(character);
}

/** The last character of the text, a whole code point: its last two code units are one when they are a surrogate pair. */
function lastCodePoint(text: string): string {
    return [...text.slice(-2)].at(-1) ?? "";
}

/**
 * True when the element's edge falls inside a ZWJ emoji sequence (`<b>👩</b>‍👩`). A delimiter there parts the joiner
 * from an emoji and breaks the sequence; formatting shows nothing on an emoji anyway, so it is left unmarked.
 */
function isInEmojiSequence(element: Element, lookup: RuleLookup): boolean {
    const first = edgeText(element, "first", lookup);
    const last = edgeText(element, "last", lookup);

    const head = first.trimStart();
    const tail = last.trimEnd();
    // A joiner at an edge joins an emoji inside to one outside; one beside plain text joins nothing.
    const isJoinedAtStart = head.startsWith(JOINER) && isEmojiOrEmpty(firstCodePoint(head.slice(1))) && isEmojiBefore(element, lookup);
    const isJoinedAtEnd = tail.endsWith(JOINER) && EMOJI_EDGE.test(lastCodePoint(tail.slice(0, -1))) && isEmojiAfter(element, lookup);

    if (isJoinedAtStart || isJoinedAtEnd) {
        return true;
    }

    const isJoinedAfter = EMOJI_EDGE.test(lastCodePoint(last)) && neighbourText(element, "first", lookup).startsWith(JOINER);

    return isJoinedAfter || (EMOJI_EDGE.test(firstCodePoint(first)) && neighbourText(element, "last", lookup).endsWith(JOINER));
}

const textsAfter = new WeakMap<Node, string>();
const textsBefore = new WeakMap<Node, string>();

/**
 * The text beside the node: at the start of what the page shows after it ("first") or at the end of what it shows
 * before it ("last"). With no such sibling, the text beside its inline parent, up to the nearest block. Remembered for
 * each node on the way up, so nested formatting reads it once.
 */
function neighbourText(node: Node, side: "first" | "last", lookup: RuleLookup): string {
    const known = side === "first" ? textsAfter : textsBefore;
    const chain: Node[] = [];
    let current: Node | null = node;
    let text = "";

    while (current) {
        const cached = known.get(current);

        if (cached !== undefined) {
            text = cached;
            break;
        }

        chain.push(current);

        const sibling = textSibling(current, side, lookup);

        if (sibling) {
            text = edgeText(sibling, side, lookup);
            break;
        }

        const parent: Node | null = current.parentNode;

        current = parent?.nodeType === 1 && !isBlock(parent) ? parent : null;
    }

    for (const member of chain) {
        known.set(member, text);
    }

    return text;
}

export function withoutMarks(text: string): string {
    return text.includes(NORMAL_START) || text.includes(NORMAL_END) ? text.replaceAll(NORMAL_START, "").replaceAll(NORMAL_END, "") : text;
}

/** Every mark taken out: what a page's own text holds of them is no mark. */
function withoutAnyMarks(text: string): string {
    let rest = text;

    for (const mark of ALL_MARKS) {
        rest = rest.replaceAll(mark, "");
    }

    return rest;
}

/** The delimiters in place of their marks. Two runs of one kind side by side are one: the closer and opener between go. */
function writeDelimiters(markdown: string, options: Options): string {
    const written: ReadonlyArray<readonly [Delimiter, string]> = [
        [STRONG, options.strongDelimiter],
        [EMPHASIS, options.emDelimiter],
        [STRIKE, "~~"],
    ];

    let text = markdown;

    for (const [delimiter, value] of written) {
        text = text
            .replaceAll(delimiter.close + delimiter.open, "")
            .replaceAll(delimiter.open, () => value)
            .replaceAll(delimiter.close, () => value);
    }

    return text;
}

/** True for whitespace and a line break's mark, which stay outside a delimiter. */
function isEdgeSpace(char: string): boolean {
    return char === LINE_BREAK_MARK || char.trim() === "";
}

/**
 * The delimiter around the text, with the whitespace and line breaks at its ends kept outside, where Markdown lets a
 * delimiter be.
 */
function wrapEdges(text: string, marker: Delimiter): string {
    let start = 0;
    let end = text.length;

    while (start < end && isEdgeSpace(text.charAt(start))) {
        start += 1;
    }

    while (end > start && isEdgeSpace(text.charAt(end - 1))) {
        end -= 1;
    }

    if (start === end) {
        return text;
    }

    return `${text.slice(0, start)}${marker.open}${text.slice(start, end)}${marker.close}${text.slice(end)}`;
}

/**
 * `marker` around each run of the content between normal-weight marks, paragraph by paragraph: emphasis cannot span a
 * blank line. A normal-weight run that goes on past one is closed before it and opened again after it.
 */
function wrapRuns(content: string, marker: Delimiter, isBold: boolean): string {
    // A blank line parts paragraphs; it may hold the mark of the line break that made it.
    const pieces = content.split(BLANK_LINE);

    if (pieces.length === 1) {
        return wrapParagraph(content, marker, isBold);
    }

    let isOpen = false;

    // The pieces alternate: a paragraph, then the blank line after it, kept as it is.
    return pieces
        .map((piece, index) => {
            if (index % 2 === 1) {
                return piece;
            }

            const opened = isOpen ? `${NORMAL_START}${piece}` : piece;

            isOpen = opened.lastIndexOf(NORMAL_START) > opened.lastIndexOf(NORMAL_END);

            return wrapParagraph(isOpen ? `${opened}${NORMAL_END}` : opened, marker, isBold);
        })
        .join("");
}

/**
 * `marker` around each run of one paragraph between normal-weight marks. Bold leaves a marked run as it is and drops its
 * marks; italics and strikethrough go inside the marks as well, so the bold around them never splits a delimiter.
 */
function wrapParagraph(content: string, marker: Delimiter, isBold: boolean): string {
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
    return !hasStructure(element, lookup) && !isInEmojiSequence(element, lookup);
}

/**
 * True when an element around this one writes this formatting already: `<b>`, `<i>` or `<s>`, or a styled element
 * that can write it. A styled block holding a list writes none, so the formatting inside it writes its own.
 */
function isFormattedAbove(element: Element, kind: Kind, lookup: RuleLookup): boolean {
    // A heading is bold already: Markdown writes it so.
    if (kind === "isBold" && isInHeading(element)) {
        return true;
    }

    const above = formattingFrom(element.parentNode, kind);

    // A built-in rule writes `<b>`, `<i>` or `<s>` whatever it holds; the preset's rule writes one it took over only
    // when it can.
    if (above === null) {
        return false;
    }

    // A `<b>` the preset took over because it parts an emoji sequence writes none.
    const isBuiltIn = isNamed(above) && !carriersOf(above).has(above) && !isInEmojiSequence(above, lookup);

    return isBuiltIn || canWrap(above, lookup);
}

/**
 * True for `<b>`, `<i>` or `<s>` right beside a styled element with the same formatting: the preset writes both, so
 * their delimiters join into one run: a bold span `Hel` and a `<b>lo</b>` beside it are `**Hello**`.
 */
function hasStyledNeighbour(element: Element): boolean {
    const emphasis = emphasisOf(element);

    return [element.previousSibling, element.nextSibling].some((sibling) => {
        if (sibling?.nodeType !== 1 || isNamed(sibling as Element) || !STYLED.has(sibling.nodeName)) {
            return false;
        }

        const beside = emphasisOf(sibling as Element);

        return KINDS.some((kind) => hasKind(emphasis, kind) && hasKind(beside, kind));
    });
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

/** The element's content with the bold, italics and strikethrough its name or style gives it, and its normal-weight marks. */
function formatted(content: string, node: Element, lookup: RuleLookup): string {
    // A task list item's box stays right after its marker, outside the delimiters, so it is still a box.
    const found = node.nodeName === "LI" ? TASK_BOX.exec(content) : null;
    const box = found?.[0] ?? "";

    return box + formattedText(content.slice(box.length), node, lookup);
}

function formattedText(content: string, node: Element, lookup: RuleLookup): string {
    const emphasis = emphasisOf(node);
    const isWrapped = canWrap(node, lookup);
    let text = content;

    if (emphasis.isBold || linkRuns.has(node)) {
        // Bold inside bold writes no second pair; the marks wait for the bold around it. A link holding a normal-weight
        // run writes its label's bold runs, and the link as a whole is then marked normal.
        if (linkRuns.has(node) || !isFormattedAbove(node, "isBold", lookup)) {
            text = isWrapped ? wrapRuns(text, STRONG, true) : withoutMarks(text);
        }
    } else if (isUnbold(node) && isNamed(node) && text.trim() !== "") {
        // All of it is normal weight, so marks inside it are not needed.
        text = `${NORMAL_START}${withoutMarks(text)}${NORMAL_END}`;
    }

    if (isWrapped && emphasis.isItalic && !isFormattedAbove(node, "isItalic", lookup)) {
        text = wrapRuns(text, EMPHASIS, false);
    }

    if (isWrapped && emphasis.isStrike && !isFormattedAbove(node, "isStrike", lookup)) {
        text = wrapRuns(escapeTildes(text), STRIKE, false);
    }

    return text;
}

// Bold, italics and strikethrough set by a style, and text set back to normal weight inside bold. A styled block passes
// its formatted text on to the rule that writes the block: a paragraph, a list item, a table cell.
const styledText: Rule = {
    filter: (node, _options, lookup) => {
        if (lookup.isRemoved(node) || isInCode(node)) {
            return false;
        }

        if (isNamed(node)) {
            return (
                isUnbold(node) || carriersOf(node).has(node) || isInEmojiSequence(node, lookup) || isNestedInStyled(node, lookup) || hasStyledNeighbour(node)
            );
        }

        const emphasis = emphasisOf(node);

        if (node.nodeName === "A" && carriersOf(node).has(node) && linkRuns.has(node)) {
            return true;
        }

        return STYLED.has(node.nodeName) && (emphasis.isBold || emphasis.isItalic || emphasis.isStrike || isUnbold(node));
    },
    replacement(content, node, options, lookup) {
        const text = formatted(content, node, lookup);

        if (isNamed(node)) {
            return text;
        }

        const next = lookup.ruleAfter(styledText, node);
        const isMarkedWhole = isUnbold(node) || linkRuns.has(node);
        const written = next.replacement.call(next, isMarkedWhole ? withoutMarks(text) : text, node, options, lookup);

        // Marked around what the element's rule writes, not inside it: a link's label is not where its bold ends.
        return isMarkedWhole ? markNormal(written) : written;
    },
};

/** The marks around a normal-weight element's Markdown, inside the line breaks at its ends. */
function markNormal(markdown: string): string {
    const core = markdown.trim();

    if (core === "") {
        return markdown;
    }

    const start = markdown.indexOf(core);

    return `${markdown.slice(0, start)}${NORMAL_START}${core}${NORMAL_END}${markdown.slice(start + core.length)}`;
}

export const styleRules: Record<string, Rule> = { styledText };

/** The element's attributes, copied by index: domino's NamedNodeMap is not iterable. */
function attributesOf(element: Element): Attr[] {
    const { attributes } = element;

    return Array.from({ length: attributes.length }, (_unused, index) => attributes[index] as Attr);
}

/**
 * Takes the marks out of the node's text and attributes, in place. A parsed string needs it too: a character reference
 * such as `&#3;` decodes into a mark.
 */
function stripMarks(root: Node): Node {
    const pending: Node[] = [root];

    while (pending.length > 0) {
        const node = pending.pop() as Node;

        // Text, CDATA and comments.
        if (TEXT_TYPES.has(node.nodeType)) {
            node.nodeValue = withoutAnyMarks(node.nodeValue ?? "");
        } else if (node.nodeType === 1) {
            for (const attribute of attributesOf(node as Element)) {
                attribute.value = withoutAnyMarks(attribute.value);
            }
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
            pending.push(child);
        }
    }

    return root;
}

/**
 * Takes the marks out of what is converted, so only the preset writes them, and out of what it gives back. The output
 * also loses the blank text before its first content, such as the spaces between the elements of a pasted `<head>`.
 * `prepare` sees the parsed input, or a copy of the node passed in, before it is converted.
 */
export function guardMarks(service: TurndownService, prepare: (root: Node) => void): void {
    const convert = service.turndown.bind(service);
    const finish = (markdown: string): string =>
        // The end is trimmed again once the line break marks are out: the conversion's own trim stops at a mark.
        withoutMarks(writeDelimiters(markdown, service.options)).replaceAll(LINE_BREAK_MARK, "").replace(LEADING_SPACE, "").trimEnd();

    const turndown = (input: TurndownInput): string => {
        const isNode = typeof input === "object" && input !== null && typeof (input as Partial<Node>).nodeType === "number";

        // Nothing to parse in an empty string: the conversion gives "" without a parser.
        if (input === "" || (typeof input !== "string" && !isNode)) {
            return convert(input);
        }

        // A node passed in is copied below: one nested too deep is refused before the copy walks it. Parsed input is
        // checked before anything else walks it.
        const root = typeof input === "string" ? parseRoot(withoutAnyMarks(input)) : input;

        checkDepth(root);

        const copy = stripMarks(root === input ? root.cloneNode(true) : root);

        prepare(copy);

        return finish(convert(copy));
    };

    Object.assign(service, { turndown });
}

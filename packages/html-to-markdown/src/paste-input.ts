/**
 * The pasted DOM, checked and set in order before it is converted. A paste nested too deep, or so deep that its quotes
 * and formatting would rebuild the same lines over and over, is refused with a RangeError: the caller pastes its plain
 * text instead. Text placed straight in a list, outside any item, becomes an item of its own.
 */
import { isBlock } from "./utilities";

/** Elements deep the conversion goes, well before the stack runs out. A table and its cell count as one level. */
const MAX_DEPTH = 500;
/** Elements deep the conversion goes, every element counted: table parts nested in each other have no cell between. */
const MAX_ELEMENT_DEPTH = 1000;
/** Characters quotes and list items may re-indent in all: each re-indents all it holds, so deep nesting is quadratic. */
const MAX_INDENT_WORK = 20_000_000;

/**
 * Characters formatting may rebuild line by line: a real paste wraps its lines a few times, a crafted one nests hundreds
 * of elements around the same lines.
 */
const MAX_WRAP_WORK = 2_000_000;
/** Characters formatting may write in all, on one line or many: each element around a text writes all of it again. */
const MAX_FORMAT_WORK = 20_000_000;
// The characters each level of a quote or a list item puts before a line: `> `, or an item's indent.
const INDENT_WIDTH = 2;
const INDENTING = new Set(["BLOCKQUOTE", "LI"]);
// Elements whose rule writes all they hold again: formatting, and inline code, which reads its text for backticks.
// Raised and lowered text reads its text for the characters it maps, and writes it again.
const FORMATTING = new Set(["B", "CODE", "DEL", "EM", "I", "S", "STRIKE", "STRONG", "SUB", "SUP"]);
// Elements whose whitespace the preset keeps as written: code (`preformattedCode`) and code blocks.
const KEEPS_WHITESPACE = new Set(["CODE", "PRE"]);
const LISTS = new Set(["OL", "UL"]);
// The parts of a table between a table and its cells, which add no depth of their own: the cell is the next level.
const TABLE_PARTS = new Set(["TBODY", "TFOOT", "THEAD", "TR"]);
const NON_BLANK = /[^\t\n\f\r ]/;
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

/** What the page shows: the elements it hides, and the text an image stands for ("" for an image that is none). */
export interface Shown {
    imageText: (image: Element) => string;
    isHidden: (node: Node) => boolean;
}

/** What an element's content measures: its characters once whitespace is collapsed, and its line breaks. */
interface Measure {
    lines: number;
    size: number;
}

/** A step of the walk: an element to open, or one whose children are measured, to close. */
interface Step {
    depth: number;
    element: Element;
    isClosing: boolean;
    // In code, where whitespace is kept as written.
    isCode: boolean;
    level: number;
}

/** The work the conversion is given, spent as the walk measures what each element holds. */
interface Work {
    format: number;
    indent: number;
    wrap: number;
}

/**
 * Throws a RangeError when `root` is nested deeper than the conversion goes. Run on a node passed in before it is
 * copied, so a copy never walks too deep either. One walk without recursion: the check costs no stack.
 */
export function checkDepth(root: Node): void {
    const pending: { level: number; node: Node }[] = [{ level: 0, node: root }];

    while (pending.length > 0) {
        const { level, node } = pending.pop() as { level: number; node: Node };

        if (level > MAX_ELEMENT_DEPTH) {
            throw new RangeError("Nested too deep to convert");
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1) {
                pending.push({ level: level + 1, node: child });
            }
        }
    }
}

/**
 * Throws a RangeError when the conversion of what `root` holds would go past a budget: nested deeper than MAX_DEPTH, or
 * more characters re-indented or re-written than the conversion is given. The content is measured once, in one walk
 * without recursion, so the check itself costs no stack.
 */
export function checkWork(root: Node, shown: Shown): void {
    const measures = new Map<Node, Measure>();
    const steps: Step[] = [];
    let work: Work = { format: 0, indent: 0, wrap: 0 };

    pushElements(steps, root, { depth: 1, isCode: false, level: 1 });

    while (steps.length > 0) {
        const step = steps.pop() as Step;
        const { element } = step;

        if (!step.isClosing) {
            if (step.depth > MAX_DEPTH || step.level > MAX_ELEMENT_DEPTH) {
                throw new RangeError("Nested too deep to convert");
            }

            steps.push({ ...step, isClosing: true });
            pushElements(steps, element, {
                depth: TABLE_PARTS.has(element.nodeName) ? step.depth : step.depth + 1,
                isCode: step.isCode || KEEPS_WHITESPACE.has(element.nodeName),
                level: step.level + 1,
            });
            continue;
        }

        // What the page hides is not converted: it costs no work, and holds none for the elements around it.
        if (shown.isHidden(element)) {
            dropMeasures(element, measures);
            measures.set(element, { lines: 0, size: 0 });
            continue;
        }

        const measure = measureOf(element, measures, step.isCode || KEEPS_WHITESPACE.has(element.nodeName));

        // An image is written as the text it stands for: an emoji's, or a formula's, which may be long.
        if (element.nodeName === "IMG") {
            measure.size += shown.imageText(element).length;
        }

        work = spend(work, element, measure);
        measures.set(element, measure);
    }
}

/** True for an element that re-indents every line it holds: a quote, a list item, a list placed straight in a list. */
function isIndenting(element: Element): boolean {
    return INDENTING.has(element.nodeName) || (LISTS.has(element.nodeName) && LISTS.has(element.parentNode?.nodeName ?? ""));
}

/** The work left after the element's rule does its work on what it holds. Throws once a budget is spent. */
function spend(work: Work, element: Element, measure: Measure): Work {
    let spent = work;

    if (isIndenting(element)) {
        spent = { ...work, indent: work.indent + measure.size };
    } else if (FORMATTING.has(element.nodeName) || element.hasAttribute("style")) {
        spent = { ...work, format: work.format + measure.size, wrap: work.wrap + (measure.lines > 0 ? measure.size : 0) };
    }

    if (spent.indent > MAX_INDENT_WORK || spent.wrap > MAX_WRAP_WORK || spent.format > MAX_FORMAT_WORK) {
        throw new RangeError("Too much work to convert");
    }

    return spent;
}

function pushElements(steps: Step[], parent: Node, place: Pick<Step, "depth" | "isCode" | "level">): void {
    for (let child = parent.lastChild; child; child = child.previousSibling) {
        if (child.nodeType === 1) {
            steps.push({ ...place, element: child as Element, isClosing: false });
        }
    }
}

/**
 * The element's measure, from its text and its child elements' measures, which are taken out of the map once read. Text
 * is counted as the conversion sees it: a run of whitespace is one space, except in code, which keeps it as written,
 * each newline a line.
 */
function measureOf(element: Element, measures: Map<Node, Measure>, isCode: boolean): Measure {
    const measure: Measure = { lines: element.nodeName === "BR" || isBlock(element) ? 1 : 0, size: 1 };

    for (let child = element.firstChild; child; child = child.nextSibling) {
        const inner = measures.get(child);

        if (inner) {
            measures.delete(child);
            measure.lines += inner.lines;
            measure.size += inner.size;
        } else if (child.nodeType === 3 || child.nodeType === 4) {
            const text = child.nodeValue ?? "";

            measure.size += isCode ? text.length : collapsedLength(text);
            measure.lines += isCode ? newlines(text) : 0;
        }
    }

    // Each line the element re-indents gets an indent.
    if (isIndenting(element)) {
        measure.size += measure.lines * INDENT_WIDTH;
    }

    return measure;
}

/** Takes the measures of the element's children out of the map, unread. */
function dropMeasures(element: Element, measures: Map<Node, Measure>): void {
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        measures.delete(child);
    }
}

function newlines(text: string): number {
    let count = 0;

    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
        count += 1;
    }

    return count;
}

/** The length of the text with each run of whitespace counted as one character. */
function collapsedLength(text: string): number {
    let length = 0;
    let isSpace = false;

    for (const char of text) {
        const isWhitespace = WHITESPACE.has(char);

        length += isWhitespace && isSpace ? 0 : 1;
        isSpace = isWhitespace;
    }

    return length;
}

/**
 * Puts text placed straight in a list, outside any item, in an item of its own, as a page shows it on a line of its own:
 * each run of text and inline elements between the items that holds text, or an image that stands for text.
 */
export function wrapLooseListText(root: Node, shown: Shown): void {
    const lists: Element[] = [];
    const pending: Node[] = [root];

    while (pending.length > 0) {
        const node = pending.pop() as Node;

        if (LISTS.has(node.nodeName)) {
            lists.push(node as Element);
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1) {
                pending.push(child);
            }
        }
    }

    for (const list of lists) {
        for (const run of looseRuns(list, shown)) {
            const item = list.ownerDocument.createElement("li");

            list.insertBefore(item, run[0] as Node);

            for (const node of run) {
                // eslint-disable-next-line unicorn/prefer-dom-node-append -- domino, the parser on servers, has no append.
                item.appendChild(node);
            }
        }
    }
}

/** The list's runs of children outside its items that hold text the page shows. */
function looseRuns(list: Element, shown: Shown): Node[][] {
    const runs: Node[][] = [];
    let run: Node[] = [];
    let hasText = false;
    const close = (): void => {
        if (hasText) {
            runs.push(run);
        }

        run = [];
        hasText = false;
    };

    for (let child = list.firstChild; child; child = child.nextSibling) {
        // A hidden element parts no run: the page shows the text around it on one line.
        if (child.nodeType === 1 && !shown.isHidden(child) && (child.nodeName === "LI" || LISTS.has(child.nodeName) || isBlock(child))) {
            close();
        } else {
            run.push(child);
            hasText ||= hasShownText(child, shown);
        }
    }

    close();

    return runs;
}

/**
 * True when the page shows text in the node, or an image that stands for text. The walk stops at the first it finds, and
 * does not go into a list or an item, which the list writes apart: each list's run is read once.
 */
function hasShownText(node: Node, shown: Shown): boolean {
    const pending: Node[] = [node];

    while (pending.length > 0) {
        const current = pending.pop() as Node;

        if (current.nodeType === 3 || current.nodeType === 4) {
            if (NON_BLANK.test(current.nodeValue ?? "")) {
                return true;
            }
        } else if (current.nodeType === 1 && !shown.isHidden(current) && !isListPart(current)) {
            if (current.nodeName === "IMG" && shown.imageText(current as Element) !== "") {
                return true;
            }

            for (let child = current.firstChild; child; child = child.nextSibling) {
                pending.push(child);
            }
        }
    }

    return false;
}

function isListPart(node: Node): boolean {
    return node.nodeName === "LI" || LISTS.has(node.nodeName);
}

/**
 * The text the page shows of a node: its text, and that of the elements in it the page does not hide. Read in one walk
 * without recursion.
 */
export function shownText(node: Node, isHidden: (node: Node) => boolean): string {
    const parts: string[] = [];
    const pending: Node[] = [node];

    while (pending.length > 0) {
        const current = pending.pop() as Node;

        if (current.nodeType === 3 || current.nodeType === 4) {
            parts.push(current.nodeValue ?? "");
        } else if (current.nodeType === 1 && !isHidden(current)) {
            for (let child = current.lastChild; child; child = child.previousSibling) {
                pending.push(child);
            }
        }
    }

    return parts.join("");
}

/**
 * The pasted DOM, checked and set in order before it is converted. A paste nested too deep, or so deep that its quotes
 * and formatting would rebuild the same lines over and over, is refused with a RangeError: the caller pastes its plain
 * text instead. Text placed straight in a list, outside any item, becomes an item of its own.
 */
import { isUnsafeDestination } from "./commonmark-rules";
import { declaredProperties } from "./inline-style";
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

/**
 * Characters all elements may join of what they hold: a real paste nests its text some tens of elements deep, a crafted
 * one hundreds of plain elements around long text.
 */
const MAX_ELEMENT_WORK = 100_000_000;
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
const HEADINGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
// The blocks in a heading that hold its text: their text goes on the heading's line.
const HEADING_PARAGRAPHS = new Set(["DIV", "P"]);
// The parts of a table between a table and its cells, which add no depth of their own: the cell is the next level.
const TABLE_PARTS = new Set(["TBODY", "TFOOT", "THEAD", "TR"]);
const NON_BLANK = /[^\t\n\f\r ]/;
// What `previousItem` gives for loose text that follows a block, not an item.
const AFTER_BLOCK = Symbol("after a block");
// The properties the paste style rules read.
const FORMATTING_PROPERTIES = new Set(["font-style", "font-weight", "text-decoration", "text-decoration-line"]);
// The characters Markdown escaping may put a backslash before: each may be written as two.
const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|<>~");
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

/** What the page shows: the elements it hides, and the text an image stands for ("" for an image that is none). */
export interface Shown {
    imageText: (image: Element) => string;
    isHidden: (node: Node) => boolean;
    // The TeX source a formula is written as, from an annotation the page hides; "" for a formula written as its text.
    mathText: (math: Element) => string;
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
    // Hidden by the page, or inside an element it hides: converted to nothing, so it costs no work.
    isHidden: boolean;
    level: number;
}

/** The work the conversion is given, spent as the walk measures what each element holds. */
interface Work {
    // What every element's rule joins of what it holds: nesting plain elements around long text costs work too.
    all: number;
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
    let work: Work = { all: 0, format: 0, indent: 0, wrap: 0 };

    pushElements(steps, root, { depth: 1, isCode: false, isHidden: false, level: 1 });

    while (steps.length > 0) {
        const step = steps.pop() as Step;
        const { element } = step;

        if (!step.isClosing) {
            if (step.depth > MAX_DEPTH || step.level > MAX_ELEMENT_DEPTH) {
                throw new RangeError("Nested too deep to convert");
            }

            const isHidden = step.isHidden || shown.isHidden(element);

            steps.push({ ...step, isClosing: true, isHidden });
            pushElements(steps, element, {
                depth: TABLE_PARTS.has(element.nodeName) ? step.depth : step.depth + 1,
                isCode: step.isCode || KEEPS_WHITESPACE.has(element.nodeName),
                isHidden,
                level: step.level + 1,
            });
            continue;
        }

        // What the page hides is not converted: it costs no work, and holds none for the elements around it. The depth
        // checks still go through it, above.
        if (step.isHidden) {
            dropMeasures(element, measures);
            measures.set(element, { lines: 0, size: 0 });
            continue;
        }

        const measure = measureOf(element, measures, step.isCode || KEEPS_WHITESPACE.has(element.nodeName));

        measure.size += writtenLength(element, shown);

        work = spend(work, element, measure);
        measures.set(element, measure);
    }
}

/** True for an element that re-indents every line it holds: a quote, a list item, a list placed straight in a list. */
function isIndenting(element: Element): boolean {
    return INDENTING.has(element.nodeName) || (LISTS.has(element.nodeName) && LISTS.has(element.parentNode?.nodeName ?? ""));
}

/**
 * True for a style that declares a property the style rules read: a weight, a font style or a text decoration. A
 * color, a size, a font family or a custom property formats nothing, so it costs no work.
 */
function isFormattingStyle(style: string): boolean {
    if (style === "") {
        return false;
    }

    for (const property of declaredProperties(style)) {
        if (FORMATTING_PROPERTIES.has(property)) {
            return true;
        }
    }

    return false;
}

/** The work left after the element's rule does its work on what it holds. Throws once a budget is spent. */
function spend(work: Work, element: Element, measure: Measure): Work {
    let spent: Work = { ...work, all: work.all + measure.size };

    if (isIndenting(element)) {
        spent = { ...spent, indent: spent.indent + measure.size };
    } else if (FORMATTING.has(element.nodeName) || isFormattingStyle(element.getAttribute("style") ?? "")) {
        spent = { ...spent, format: spent.format + measure.size, wrap: spent.wrap + (measure.lines > 0 ? measure.size : 0) };
    }

    if (spent.all > MAX_ELEMENT_WORK || spent.indent > MAX_INDENT_WORK || spent.wrap > MAX_WRAP_WORK || spent.format > MAX_FORMAT_WORK) {
        throw new RangeError("Too much work to convert");
    }

    return spent;
}

/**
 * What the element's rule writes besides what it holds: an image's emoji or formula text, which may be long, a
 * formula's TeX source, and a link's destination and title.
 */
function writtenLength(element: Element, shown: Shown): number {
    if (element.nodeName === "IMG") {
        return shown.imageText(element).length;
    }

    if (element.nodeName.toUpperCase() === "MATH") {
        return shown.mathText(element).length;
    }

    // A link to an unsafe destination is written as its text alone: its destination and title cost nothing.
    const attribute = element.nodeName === "A" ? element.getAttribute("href") : null;
    const href = attribute ?? "";

    // Only a link written as one: with a destination, and a safe one. Any other is its text alone.
    if (href !== "" && !isUnsafeDestination(href)) {
        return href.length + (element.getAttribute("title")?.length ?? 0);
    }

    return 0;
}

function pushElements(steps: Step[], parent: Node, place: Pick<Step, "depth" | "isCode" | "isHidden" | "level">): void {
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

/** The length of the text in string units, with each run of whitespace counted as one. */
function collapsedLength(text: string): number {
    let length = 0;
    let isSpace = false;

    for (const char of text) {
        const isWhitespace = WHITESPACE.has(char);

        // A character outside the Basic Multilingual Plane, such as an emoji, is two units of a JavaScript string; one
        // Markdown escapes is written with a backslash before it.
        const written = char.length + (ESCAPABLE.has(char) ? 1 : 0);

        length += isWhitespace && isSpace ? 0 : written;
        isSpace = isWhitespace;
    }

    return length;
}

/**
 * Writes the paragraphs and divs on a heading's line as spans, their text kept on the heading's line: a
 * heading holds one line, and `<h2><p>Title</p></h2>` is the heading `Title`. The span keeps every attribute, so what
 * hides the text, its style and its class (a code block's language) still apply. A space on each side keeps its words
 * apart from those around it; HTML whitespace collapses any extra. Other blocks in a heading, such as a code block,
 * stay blocks.
 */
export function unwrapHeadingParagraphs(root: Node, shown: Shown): void {
    const pending: Node[] = [root];

    while (pending.length > 0) {
        const node = pending.pop() as Node;

        if (HEADINGS.has(node.nodeName)) {
            inlineParagraphChildren(node as Element, shown);
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1 && !shown.isHidden(child)) {
                pending.push(child);
            }
        }
    }
}

/**
 * The paragraphs and divs on a heading's line, in order: its own, and those inside an inline element, a paragraph or a
 * div on that line. A code block, a list, a table or a quote holds lines of its own, so the walk stops there.
 */
function headingParagraphs(heading: Element, shown: Shown): Element[] {
    const paragraphs: Element[] = [];
    const pending: Element[] = [];

    for (let child = heading.lastElementChild; child; child = child.previousElementSibling) {
        pending.push(child);
    }

    while (pending.length > 0) {
        const element = pending.pop() as Element;
        const isParagraph = HEADING_PARAGRAPHS.has(element.nodeName);

        if (shown.isHidden(element) || (!isParagraph && isBlock(element))) {
            continue;
        }

        if (isParagraph) {
            paragraphs.push(element);
        }

        for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
            pending.push(child);
        }
    }

    return paragraphs;
}

function inlineParagraphChildren(heading: Element, shown: Shown): void {
    const document = heading.ownerDocument;

    for (const paragraph of headingParagraphs(heading, shown)) {
        const parent = paragraph.parentNode as Node;
        const span = document.createElement("span");

        for (let index = 0; index < paragraph.attributes.length; index += 1) {
            const attribute = paragraph.attributes[index] as Attr;

            span.setAttribute(attribute.name, attribute.value);
        }

        while (paragraph.firstChild) {
            // eslint-disable-next-line unicorn/prefer-dom-node-append -- domino, the parser on servers, has no append.
            span.appendChild(paragraph.firstChild);
        }

        parent.insertBefore(document.createTextNode(" "), paragraph);
        // eslint-disable-next-line unicorn/prefer-modern-dom-apis -- domino, the parser on servers, has no before.
        parent.insertBefore(span, paragraph);
        parent.insertBefore(document.createTextNode(" "), paragraph);
        paragraph.remove();
    }
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

        // What the page hides is left whole for the conversion to drop: no text is moved out of it.
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1 && !shown.isHidden(child)) {
                pending.push(child);
            }
        }
    }

    // Nested lists first: one may hand loose text that leads it to the list around it, which then reads it as its own.
    for (const list of lists.toReversed()) {
        for (const run of looseRuns(list, shown)) {
            placeRun(list, run, shown);
        }
    }
}

/**
 * Puts a run of loose text where the page shows it. In a bulleted list it is an item of its own. In a numbered list it
 * takes no number and renumbers no item: it goes on a line of its own in the item before it, or before the list when
 * no item comes first.
 */
function placeRun(list: Element, run: Node[], shown: Shown): void {
    const document = list.ownerDocument;
    const first = run[0] as Node;
    let target: Node;

    if (list.nodeName === "OL") {
        const item = previousItem(first, shown);

        if (item === null && list.parentNode !== null) {
            for (const node of run) {
                list.parentNode.insertBefore(node, list);
            }

            return;
        }

        // After a block or a list the page shows, the text stays in place as a block of its own: moved into the
        // item before, it would go ahead of what comes between. So does text that leads a list converted on its own,
        // which has nothing around it to move the text to.
        if (item === AFTER_BLOCK || item === null) {
            target = document.createElement("div");
            // eslint-disable-next-line unicorn/prefer-modern-dom-apis -- domino, the parser on servers, has no before.
            list.insertBefore(target, first);

            for (const node of run) {
                // eslint-disable-next-line unicorn/prefer-dom-node-append -- domino, the parser on servers, has no append.
                target.appendChild(node);
            }

            return;
        }

        target = item;
        // eslint-disable-next-line unicorn/prefer-dom-node-append -- domino, the parser on servers, has no append.
        item.appendChild(document.createElement("br"));
    } else {
        target = document.createElement("li");
        // eslint-disable-next-line unicorn/prefer-modern-dom-apis -- domino, the parser on servers, has no before.
        list.insertBefore(target, first);
    }

    for (const node of run) {
        // eslint-disable-next-line unicorn/prefer-dom-node-append -- domino, the parser on servers, has no append.
        target.appendChild(node);
    }
}

/**
 * The item the page shows right before the node, past hidden elements and blank text; AFTER_BLOCK when another
 * element the page shows comes first; or null when nothing does. A hidden item is dropped with all it holds.
 */
function previousItem(node: Node, shown: Shown): Element | typeof AFTER_BLOCK | null {
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (sibling.nodeType === 1 && !shown.isHidden(sibling)) {
            return sibling.nodeName === "LI" ? (sibling as Element) : AFTER_BLOCK;
        }

        if ((sibling.nodeType === 3 || sibling.nodeType === 4) && NON_BLANK.test(sibling.nodeValue ?? "")) {
            return AFTER_BLOCK;
        }
    }

    return null;
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
            if (isTextElement(current as Element, shown)) {
                return true;
            }

            for (let child = current.firstChild; child; child = child.nextSibling) {
                pending.push(child);
            }
        }
    }

    return false;
}

/** True for an image or a formula written as text: an emoji, or a formula's TeX source. */
function isTextElement(element: Element, shown: Shown): boolean {
    if (element.nodeName === "IMG") {
        return shown.imageText(element) !== "";
    }

    return element.nodeName.toUpperCase() === "MATH" && shown.mathText(element) !== "";
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

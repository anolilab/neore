/**
 * The pasted DOM, checked and set in order before it is converted. A paste nested too deep, or so deep that its quotes
 * and formatting would rebuild the same lines over and over, is refused with a RangeError: the caller pastes its plain
 * text instead. Text placed straight in a list, outside any item, becomes an item of its own.
 */
import { isBlock } from "./utilities";

/** Elements deep the conversion goes, well before the stack runs out. */
const MAX_DEPTH = 500;
/** Characters quotes and list items may re-indent in all: each re-indents all it holds, so deep nesting is quadratic. */
const MAX_INDENT_WORK = 20_000_000;

/**
 * Characters formatting may rebuild line by line: a real paste wraps its lines a few times, a crafted one nests hundreds
 * of elements around the same lines.
 */
const MAX_WRAP_WORK = 2_000_000;
// The characters each level of a quote or a list item puts before a line: `> `, or an item's indent.
const INDENT_WIDTH = 2;
const INDENTING = new Set(["BLOCKQUOTE", "LI"]);
const FORMATTING = new Set(["B", "DEL", "EM", "I", "S", "STRIKE", "STRONG"]);
const LISTS = new Set(["OL", "UL"]);
// The parts of a table between a table and its cells, which add no depth of their own: the cell is the next level.
const TABLE_PARTS = new Set(["TBODY", "TFOOT", "THEAD", "TR"]);
const NON_BLANK = /[^\t\n\f\r ]/;

/** What an element's content measures: its characters as written, and its line breaks. */
interface Measure {
    lines: number;
    size: number;
}

/** A step of the walk: an element to open, or one whose children are measured, to close. */
interface Step {
    depth: number;
    element: Element;
    isClosing: boolean;
}

/**
 * Throws a RangeError when the conversion of what `root` holds would go past a budget: nested deeper than MAX_DEPTH, or
 * more characters re-indented or re-wrapped than the conversion is given. The content is measured once, in one walk
 * without recursion, so the check itself costs no stack.
 */
export function checkWork(root: Node): void {
    const measures = new Map<Node, Measure>();
    const steps: Step[] = [];
    let indentWork = 0;
    let wrapWork = 0;

    pushElements(steps, root, 1);

    while (steps.length > 0) {
        const { depth, element, isClosing } = steps.pop() as Step;

        if (!isClosing) {
            if (depth > MAX_DEPTH) {
                throw new RangeError("Nested too deep to convert");
            }

            steps.push({ depth, element, isClosing: true });
            pushElements(steps, element, TABLE_PARTS.has(element.nodeName) ? depth : depth + 1);
            continue;
        }

        const measure = measureOf(element, measures);

        if (INDENTING.has(element.nodeName)) {
            measure.size += measure.lines * INDENT_WIDTH;
            indentWork += measure.size;
        } else if (measure.lines > 0 && (FORMATTING.has(element.nodeName) || element.hasAttribute("style"))) {
            wrapWork += measure.size;
        }

        if (indentWork > MAX_INDENT_WORK || wrapWork > MAX_WRAP_WORK) {
            throw new RangeError("Too much work to convert");
        }

        measures.set(element, measure);
    }
}

function pushElements(steps: Step[], parent: Node, depth: number): void {
    for (let child = parent.lastChild; child; child = child.previousSibling) {
        if (child.nodeType === 1) {
            steps.push({ depth, element: child as Element, isClosing: false });
        }
    }
}

/** The element's measure, from its text and its child elements' measures, which are taken out of the map once read. */
function measureOf(element: Element, measures: Map<Node, Measure>): Measure {
    const measure: Measure = { lines: element.nodeName === "BR" || isBlock(element) ? 1 : 0, size: 1 };

    for (let child = element.firstChild; child; child = child.nextSibling) {
        const inner = measures.get(child);

        if (inner) {
            measure.lines += inner.lines;
            measure.size += inner.size;
            measures.delete(child);
        } else if (child.nodeType === 3 || child.nodeType === 4) {
            measure.size += child.nodeValue?.length ?? 0;
        }
    }

    return measure;
}

/**
 * Puts text placed straight in a list, outside any item, in an item of its own, as a page shows it on a line of its own:
 * each run of text and inline elements between the items that holds text. `isHidden` tells an element the page hides.
 */
export function wrapLooseListText(root: Node, isHidden: (node: Node) => boolean): void {
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
        for (const run of looseRuns(list, isHidden)) {
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
function looseRuns(list: Element, isHidden: (node: Node) => boolean): Node[][] {
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
        if (child.nodeType === 1 && (child.nodeName === "LI" || LISTS.has(child.nodeName) || isBlock(child))) {
            close();
        } else {
            run.push(child);
            hasText ||= hasShownText(child, isHidden);
        }
    }

    close();

    return runs;
}

function hasShownText(node: Node, isHidden: (node: Node) => boolean): boolean {
    if (node.nodeType === 3 || node.nodeType === 4) {
        return NON_BLANK.test(node.nodeValue ?? "");
    }

    return node.nodeType === 1 && !isHidden(node) && NON_BLANK.test(node.textContent ?? "");
}

/**
 * List forms for the paste preset. Items are numbered as HTML numbers them, letters, roman numerals and numbers below 0
 * included. The flat lists Google Docs writes keep their depth, and so do the paragraphs Word writes a list as.
 */
import { declaredStyle } from "./inline-style";
import type { FilterFunction, Options, Rule, RuleLookup } from "./types";
import { escapeMarkdown, parseListStart, trimNewlines } from "./utilities";

/**
 * An item's marker and the width Markdown reads as the marker: a letter after a bullet (`- a. `) is text, so only the
 * bullet and its space count. The item's later lines and the lists under it are indented to that width.
 */
interface Marker {
    text: string;
    width: number;
}

/** Where an item is written: the spaces before it and its marker. */
interface ItemPlace {
    indent: number;
    /** The first item of a Word list that follows another one: a blank line parts the two. */
    isListStart?: boolean;
    marker: Marker;
}

/** An HTML list's items, placed once for the list, and the item each list placed straight in it goes under. */
interface ListLayout {
    anchors: Map<Element, Element>;
    places: Map<Element, ItemPlace>;
}

// Google Docs writes a nested item as an item of the same list with a deeper aria-level.
const MAX_ARIA_LEVEL = 6;
const WORD_LEVEL = /(?:^|\s)level(\d)(?:\s|$)/;
// The list a Word paragraph belongs to: `l0` in `mso-list:l0 level1 lfo1`.
const WORD_LIST_ID = /(?:^|\s)(l\d+)(?:\s|$)/;
// Up to nine digits, the most a Markdown marker takes, so a Word list numbered past 9999 keeps its numbers.
const WORD_NUMBER = /^\d{1,9}[.)]$/;
// CommonMark reads at most nine digits as a list number.
const MAX_MARKER_DIGITS = 9;
const LETTER_TYPES = new Set(["A", "a"]);
const ROMAN_TYPES = new Set(["I", "i"]);
const MAX_ROMAN = 3999n;
const ROMAN: ReadonlyArray<readonly [bigint, string]> = [
    [1000n, "m"],
    [900n, "cm"],
    [500n, "d"],
    [400n, "cd"],
    [100n, "c"],
    [90n, "xc"],
    [50n, "l"],
    [40n, "xl"],
    [10n, "x"],
    [9n, "ix"],
    [5n, "v"],
    [4n, "iv"],
    [1n, "i"],
];
const BULLET: Marker = { text: "- ", width: 2 };

/** A filter that matches only what no remove filter drops: the preset's rules are added, so they come before those. */
export function unlessRemoved(isMatch: (node: Element) => boolean): FilterFunction {
    return (node, _options, lookup) => isMatch(node) && !lookup.isRemoved(node);
}

function isList(node: Node | null): node is Element {
    return node?.nodeName === "OL" || node?.nodeName === "UL";
}

function msoList(node: Node): string {
    return node.nodeType === 1 ? declaredStyle((node as Element).getAttribute("style") ?? "", "mso-list") : "";
}

/** The level an `mso-list` style gives an element, or 0. */
function msoLevel(node: Node): number {
    const match = WORD_LEVEL.exec(msoList(node));

    return match ? Number(match[1]) : 0;
}

/** The level Word gives a list paragraph, or 0 for any other element. A numbered heading keeps its number as text. */
function wordLevel(node: Node): number {
    return node.nodeName === "P" ? msoLevel(node) : 0;
}

/**
 * True for the text Word writes a list paragraph's marker in, which the preset writes as the item's marker. A marker
 * in a numbered heading, or outside any list paragraph, is the element's own text.
 */
export function isWordMarker(element: Element): boolean {
    if (element.localName !== "span" || msoList(element) !== "ignore") {
        return false;
    }

    for (let above = element.parentElement; above; above = above.parentElement) {
        if (msoLevel(above) > 0) {
            return above.nodeName === "P";
        }
    }

    return false;
}

/** `number` in letters, as `<ol type="a">` shows it: `a` to `z`, then `aa`. */
function letters(number: bigint): string {
    let label = "";

    for (let rest = number; rest > 0n; rest = (rest - 1n) / 26n) {
        label = String.fromCodePoint(97 + Number((rest - 1n) % 26n)) + label;
    }

    return label;
}

function romanNumeral(number: bigint): string {
    let label = "";
    let rest = number;

    for (const [value, numeral] of ROMAN) {
        while (rest >= value) {
            label += numeral;
            rest -= value;
        }
    }

    return label;
}

/**
 * An ordered item's marker. Markdown numbers only in digits and from 0 up, so a letter, a roman numeral or a number below
 * 0 is written as text on a bullet: `- b. item`, `- -1. item`.
 */
function orderedMarker(type: string, number: bigint): Marker {
    if (LETTER_TYPES.has(type) || ROMAN_TYPES.has(type)) {
        return bulletWithLabel(`${listLabel(type, number)}.`);
    }

    const label = `${number}.`;

    // Below 0, or too long a number for a marker.
    return number < 0n || label.length > MAX_MARKER_DIGITS + 1 ? bulletWithLabel(label) : numbered(label);
}

/** `number` as a lettered or roman list shows it. Numbers they have no form for (below 1, roman past 3999) are digits. */
function listLabel(type: string, number: bigint): string {
    if (number < 1n || (ROMAN_TYPES.has(type) && number > MAX_ROMAN)) {
        return String(number);
    }

    const label = LETTER_TYPES.has(type) ? letters(number) : romanNumeral(number);

    return type === type.toUpperCase() ? label.toUpperCase() : label;
}

function bulletWithLabel(label: string): Marker {
    return { text: `${BULLET.text}${label} `, width: BULLET.width };
}

function numbered(number: string): Marker {
    return { text: `${number} `, width: number.length + 1 };
}

/** The shallowest of the levels. */
function topLevel(levels: ReadonlyArray<number>): number {
    let top = Infinity;

    for (const level of levels) {
        top = Math.min(top, level);
    }

    return top;
}

/**
 * Places items given their levels: an item deeper than the one before it is indented to that item's text, so it nests
 * under it. The shallowest level is at the left edge: a copy that starts at a nested item keeps its nesting from there.
 */
function placeItems(levels: ReadonlyArray<number>, markers: ReadonlyArray<Marker>): ItemPlace[] {
    const top = topLevel(levels);

    // The column of the text of the last item at each depth.
    const columns: number[] = [];

    return levels.map((level, index) => {
        const depth = level - top;
        const marker = markers[index] ?? BULLET;
        let indent = 0;

        for (let above = depth - 1; above >= 0; above -= 1) {
            const column = columns[above];

            if (column !== undefined) {
                indent = column;
                break;
            }
        }

        columns.length = depth;
        columns[depth] = indent + marker.width;

        return { indent, marker };
    });
}

const listLayouts = new WeakMap<Element, ListLayout>();

/**
 * Numbers and places a list's items in one pass. An ordered item takes the list's `start`, or its own `value`, and the
 * items after it count on from there, each depth on its own. An item a remove filter drops takes no number.
 */
function listLayout(list: Element, options: Options, lookup: RuleLookup): ListLayout {
    const cached = listLayouts.get(list);

    if (cached) {
        return cached;
    }

    const isOrdered = list.nodeName === "OL";
    const type = list.getAttribute("type") ?? "1";
    const start = parseListStart(list.getAttribute("start")) ?? 1n;
    const items: Element[] = [];
    const levels: number[] = [];
    const markers: Marker[] = [];
    const anchors = new Map<Element, Element>();
    const counters: bigint[] = [];

    for (let child = list.firstElementChild; child; child = child.nextElementSibling) {
        if (isList(child) && items.length > 0) {
            anchors.set(child, items.at(-1) as Element);
        }

        if (child.nodeName !== "LI" || lookup.isRemoved(child)) {
            continue;
        }

        const ariaLevel = Math.trunc(Number(child.getAttribute("aria-level") ?? 1));

        items.push(child);
        levels.push(Number.isNaN(ariaLevel) ? 1 : Math.min(Math.max(ariaLevel, 1), MAX_ARIA_LEVEL));
    }

    const top = topLevel(levels);

    for (const [index, item] of items.entries()) {
        const depth = (levels[index] ?? top) - top;
        const number = parseListStart(item.getAttribute("value")) ?? counters[depth] ?? (depth === 0 ? start : 1n);

        counters.length = depth;
        counters[depth] = number + 1n;
        markers.push(isOrdered ? orderedMarker(type, number) : bulletMarker(options));
    }

    const placed = placeItems(levels, markers);
    const layout: ListLayout = { anchors, places: new Map(items.map((item, index) => [item, placed[index] as ItemPlace])) };

    listLayouts.set(list, layout);

    return layout;
}

/**
 * The marker Word shows for a list paragraph: the first marker text in it that the page would show but for being a
 * marker. A number of up to nine digits is a Markdown number. Other text, such as `a.`, `1.1.` or `(iv)`, is kept after
 * a bullet. A single character is Word's bullet symbol.
 */
function wordMarker(paragraph: Element, lookup: RuleLookup, isHiddenOnPage: (element: Element) => boolean): Marker {
    const pending: Element[] = [paragraph];

    while (pending.length > 0) {
        const element = pending.pop() as Element;

        if (element !== paragraph && isWordMarker(element)) {
            if (isHiddenOnPage(element)) {
                continue;
            }

            return wordMarkerFrom(element.textContent?.trim() ?? "");
        }

        if (element === paragraph || !lookup.isRemoved(element)) {
            // Last child first, so the first one comes off the stack first.
            for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
                pending.push(child);
            }
        }
    }

    return BULLET;
}

function wordMarkerFrom(text: string): Marker {
    if (WORD_NUMBER.test(text)) {
        return numbered(`${text.slice(0, -1)}.`);
    }

    return [...text].length > 1 ? bulletWithLabel(escapeMarkdown(text)) : BULLET;
}

/** True for what may sit between two paragraphs of one Word list: blank text, a comment or a hidden element. */
function isBetweenWordItems(node: Node, lookup: RuleLookup): boolean {
    if (node.nodeType === 3) {
        return (node.nodeValue ?? "").trim() === "";
    }

    return node.nodeType === 8 || (node.nodeType === 1 && lookup.isRemoved(node));
}

const wordPlaces = new WeakMap<Element, ItemPlace>();

/**
 * Places every paragraph of the Word lists `paragraph` is in, once for the run of paragraphs. Paragraphs of different
 * lists (their `mso-list` ids differ) are placed apart, each list from its own top level.
 */
function wordPlace(paragraph: Element, lookup: RuleLookup, isHiddenOnPage: (element: Element) => boolean): ItemPlace {
    const cached = wordPlaces.get(paragraph);

    if (cached) {
        return cached;
    }

    let first: Node = paragraph;

    for (let sibling = paragraph.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (wordLevel(sibling) > 0 && !lookup.isRemoved(sibling)) {
            first = sibling;
        } else if (!isBetweenWordItems(sibling, lookup)) {
            break;
        }
    }

    const items: Element[] = [];

    for (let sibling: Node | null = first; sibling; sibling = sibling.nextSibling) {
        if (wordLevel(sibling) > 0 && !lookup.isRemoved(sibling)) {
            items.push(sibling as Element);
        } else if (!isBetweenWordItems(sibling, lookup)) {
            break;
        }
    }

    for (const list of splitByListId(items)) {
        const placed = placeItems(
            list.map((item) => wordLevel(item)),
            list.map((item) => wordMarker(item, lookup, isHiddenOnPage)),
        );

        for (const [index, item] of list.entries()) {
            wordPlaces.set(item, { ...(placed[index] as ItemPlace), isListStart: index === 0 && list !== items && item !== items[0] });
        }
    }

    return wordPlaces.get(paragraph) ?? { indent: 0, marker: BULLET };
}

/** The paragraphs grouped by the Word list each belongs to, in order. One without an id stays with the one before. */
function splitByListId(items: Element[]): Element[][] {
    const lists: Element[][] = [];
    let currentId: string | undefined;

    for (const item of items) {
        const id = WORD_LIST_ID.exec(msoList(item))?.[1];

        if (lists.length === 0 || (id !== undefined && currentId !== undefined && id !== currentId)) {
            lists.push([]);
        }

        currentId = id ?? currentId;
        lists.at(-1)?.push(item);
    }

    return lists.length === 1 ? [items] : lists;
}

/** The item's place: its list's, or a bullet at the left edge for an item outside a list. */
function itemPlace(item: Element, options: Options, lookup: RuleLookup): ItemPlace {
    const parent = item.parentNode as Element | null;

    return (isList(parent) ? listLayout(parent, options, lookup).places.get(item) : undefined) ?? { indent: 0, marker: bulletMarker(options) };
}

function bulletMarker(options: Options): Marker {
    return { text: `${options.bulletListMarker} `, width: options.bulletListMarker.length + 1 };
}

/**
 * The preset's `br` option: a mark before the newline of a line break, taken out at the end. A line break is then not
 * blank text, so two breaks in a row stay two lines, as the page shows them, and are not joined into one.
 */
export const LINE_BREAK_MARK = "\u{10}";

/**
 * `prefix` before each line of the text from line `from` on, and `blank` before a blank one, so no line ends in spaces
 * a composer would hide. A line that holds only a line break's mark is blank.
 */
export function prefixLines(text: string, prefix: string, blank: string, from = 0): string {
    return text
        .split("\n")
        .map((line, index) => {
            if (index < from) {
                return line;
            }

            return (line === "" || line === LINE_BREAK_MARK ? blank : prefix) + line;
        })
        .join("\n");
}

/** An item's text after its marker, with its later lines indented to the text's column. */
function writeItem(place: ItemPlace, content: string): string {
    const indent = " ".repeat(place.indent + place.marker.width);

    return `${" ".repeat(place.indent)}${place.marker.text}${prefixLines(content, indent, "", 1)}`;
}

/**
 * The list rules. `isHiddenOnPage` tells whether the page hides an element for a reason of its own, apart from being a
 * Word marker (which the preset hides because it writes the marker itself).
 */
export function listRules(isHiddenOnPage: (element: Element) => boolean): Record<string, Rule> {
    return {
        // A list placed straight in a list, not in an item, as some editors write a nested list: it goes under the item
        // before it, as it would inside that item.
        listInList: {
            filter: unlessRemoved((node) => isList(node) && isList(node.parentNode)),
            replacement(content, node, options, lookup) {
                const anchor = listLayout(node.parentNode as Element, options, lookup).anchors.get(node);

                if (!anchor) {
                    return `\n\n${content}\n\n`;
                }

                const items = trimNewlines(content);

                // A list whose items are all hidden leaves nothing, not a line that would part the items around it.
                if (items.trim() === "") {
                    return "";
                }

                const place = itemPlace(anchor, options, lookup);
                const indented = prefixLines(items, " ".repeat(place.indent + place.marker.width), "");

                return `\n${indented}${node.nextSibling ? "\n" : ""}`;
            },
        },

        // A list item written with the marker and one space, as people type it.
        listItem: {
            filter: unlessRemoved((node) => node.nodeName === "LI"),
            replacement(content, node, options, lookup) {
                return `${writeItem(itemPlace(node, options, lookup), trimNewlines(content))}${node.nextSibling ? "\n" : ""}`;
            },
        },

        // Word writes a list as paragraphs with `mso-list` styles, the marker in text it hides. Its items are on lines of
        // their own, with no blank line between them. The spaces Word puts after the marker are not the item's text.
        wordListItem: {
            filter: unlessRemoved((node) => wordLevel(node) > 0),
            replacement(content, node, _options, lookup) {
                const place = wordPlace(node, lookup, isHiddenOnPage);

                return `${place.isListStart ? "\n\n" : "\n"}${writeItem(place, content.trim())}\n`;
            },
        },
    };
}

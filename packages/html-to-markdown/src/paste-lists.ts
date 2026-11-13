/**
 * List forms for the paste preset. Items are numbered as HTML numbers them, letters, roman numerals and numbers below 0
 * included. The flat lists Google Docs writes keep their depth, and so do the paragraphs Word writes a list as.
 */
import { declaredStyle } from "./inline-style";
import type { FilterFunction, Options, Rule, RuleLookup } from "./types";
import { parseListStart, trimNewlines } from "./utilities";

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
// Up to nine digits, the most a Markdown marker takes, so a Word list numbered past 9999 keeps its numbers.
const WORD_NUMBER = /^\d{1,9}[.)]$/;
// A letter or roman numeral Word numbers a level with (`a.`, `iv)`). Markdown numbers only in digits, so it stays text.
const WORD_LETTER = /^[a-z]{1,9}[.)]$/i;
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
// The start of each line that is not blank.
const LINE_WITH_TEXT = /^(?=.)/gm;

/** A filter that matches only what no remove filter drops: the preset's rules are added, so they come before those. */
export function unlessRemoved(isMatch: (node: Element) => boolean): FilterFunction {
    return (node, _options, lookup) => isMatch(node) && !lookup.isRemoved(node);
}

function isList(node: Node | null): node is Element {
    return node?.nodeName === "OL" || node?.nodeName === "UL";
}

/** The level Word gives a list paragraph in its `mso-list` style, or 0 for any other element. */
function wordLevel(node: Node): number {
    if (node.nodeName !== "P") {
        return 0;
    }

    const match = WORD_LEVEL.exec(declaredStyle((node as Element).getAttribute("style") ?? "", "mso-list"));

    return match ? Number(match[1]) : 0;
}

/** True for the text Word writes an item's marker in: shown in Word, hidden on the page. */
export function isWordMarker(element: Element): boolean {
    return element.localName === "span" && declaredStyle(element.getAttribute("style") ?? "", "mso-list") === "ignore";
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

    return number < 0n ? bulletWithLabel(`${number}.`) : numbered(`${number}.`);
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

/** The marker Word shows for a list paragraph: the first marker text in it that is not inside other hidden text. */
function wordMarker(paragraph: Element, lookup: RuleLookup): Marker {
    const pending: Element[] = [paragraph];

    while (pending.length > 0) {
        const element = pending.pop() as Element;

        if (element !== paragraph && isWordMarker(element)) {
            const text = element.textContent?.trim() ?? "";

            if (WORD_NUMBER.test(text)) {
                return numbered(`${text.slice(0, -1)}.`);
            }

            return WORD_LETTER.test(text) ? bulletWithLabel(text) : BULLET;
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

/** True for what may sit between two paragraphs of one Word list: blank text, a comment or a hidden element. */
function isBetweenWordItems(node: Node, lookup: RuleLookup): boolean {
    if (node.nodeType === 3) {
        return (node.nodeValue ?? "").trim() === "";
    }

    return node.nodeType === 8 || (node.nodeType === 1 && lookup.isRemoved(node));
}

const wordPlaces = new WeakMap<Element, ItemPlace>();

/** Places every paragraph of the Word list `paragraph` is in, once for the list. */
function wordPlace(paragraph: Element, lookup: RuleLookup): ItemPlace {
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

    const placed = placeItems(
        items.map((item) => wordLevel(item)),
        items.map((item) => wordMarker(item, lookup)),
    );

    for (const [index, item] of items.entries()) {
        wordPlaces.set(item, placed[index] as ItemPlace);
    }

    return wordPlaces.get(paragraph) ?? { indent: 0, marker: BULLET };
}

/** The item's place: its list's, or a bullet at the left edge for an item outside a list. */
function itemPlace(item: Element, options: Options, lookup: RuleLookup): ItemPlace {
    const parent = item.parentNode as Element | null;

    return (isList(parent) ? listLayout(parent, options, lookup).places.get(item) : undefined) ?? { indent: 0, marker: bulletMarker(options) };
}

function bulletMarker(options: Options): Marker {
    return { text: `${options.bulletListMarker} `, width: options.bulletListMarker.length + 1 };
}

/** An item's text after its marker, with its later lines indented to the text's column. */
function writeItem(place: ItemPlace, content: string): string {
    const indent = " ".repeat(place.indent + place.marker.width);

    return `${" ".repeat(place.indent)}${place.marker.text}${content.replaceAll("\n", () => `\n${indent}`)}`;
}

export const listRules: Record<string, Rule> = {
    // A list placed straight in a list, not in an item, as some editors write a nested list: it goes under the item
    // before it, as it would inside that item.
    listInList: {
        filter: unlessRemoved((node) => isList(node) && isList(node.parentNode)),
        replacement(content, node, options, lookup) {
            const anchor = listLayout(node.parentNode as Element, options, lookup).anchors.get(node);

            if (!anchor) {
                return `\n\n${content}\n\n`;
            }

            const place = itemPlace(anchor, options, lookup);
            const indent = " ".repeat(place.indent + place.marker.width);
            // Blank lines stay blank: no trailing spaces.
            const indented = trimNewlines(content).replaceAll(LINE_WITH_TEXT, () => indent);

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
            return `\n${writeItem(wordPlace(node, lookup), content.trim())}\n`;
        },
    },
};

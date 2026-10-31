/**
 * What a page watcher compares: the page's visible text, or the text of the first element a simple
 * selector names. Raw HTML is never hashed: nonces, CSRF tokens and build ids would make every check a change.
 *
 * The selector is deliberately small — `tag`, `#id`, `.class`, `tag.class`, `tag#id` — because the page is
 * parsed with string scanning, not a DOM. The Worker has no parser for it, and the save-time check
 * ({@link parsePageSelector}) refuses anything else, so a selector never silently matches nothing.
 */
import { htmlToText } from "../../knowledge/sources";

export interface SimpleSelector {
    className?: string;
    id?: string;
    tag?: string;
}

const SELECTOR_RE = /^([a-z][a-z0-9-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?$/iu;
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const WHITESPACE_RE = /\s+/gu;
const CLASS_ATTR_RE = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
const ID_ATTR_RE = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

/** The selector as parts, or `undefined` when it is not one of the shapes above. */
export const parsePageSelector = (selector: string): SimpleSelector | undefined => {
    const match = SELECTOR_RE.exec(selector.trim());

    if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
        return undefined;
    }

    return {
        ...(match[3] !== undefined && { className: match[3] }),
        ...(match[2] !== undefined && { id: match[2] }),
        ...(match[1] !== undefined && { tag: match[1].toLowerCase() }),
    };
};

const attributeOf = (attributes: string, pattern: RegExp): string | undefined => {
    const match = pattern.exec(attributes);

    return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
};

const matchesSelector = (tag: string, attributes: string, selector: SimpleSelector): boolean => {
    if (selector.tag !== undefined && selector.tag !== tag) {
        return false;
    }

    if (selector.id !== undefined && attributeOf(attributes, ID_ATTR_RE) !== selector.id) {
        return false;
    }

    return selector.className === undefined || (attributeOf(attributes, CLASS_ATTR_RE) ?? "").split(WHITESPACE_RE).includes(selector.className);
};

interface Tag {
    /** What stands between the name and the closing `>`, starting with the whitespace that follows the name. */
    attributes: string;
    closing: boolean;
    /** Index just past the `>`. */
    end: number;
    name: string;
    start: number;
}

const codeAt = (text: string, index: number): number => text.codePointAt(index) ?? 0;
const isLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isNameChar = (code: number): boolean => isLetter(code) || (code >= 48 && code <= 57) || code === 45;
const isSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13);

/** The index of the `>` that ends the tag whose name ends at `from`, or -1 when the page ends first. A quoted attribute value may hold a `>`. */
const endOfTag = (html: string, from: number): number => {
    let index = from;

    while (index < html.length) {
        const code = codeAt(html, index);

        if (code === 62) {
            return index;
        }

        index += 1;

        if (code === 61) {
            while (isSpace(codeAt(html, index))) {
                index += 1;
            }

            const quote = html.charAt(index);

            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, index + 1);

                if (close === -1) {
                    return -1;
                }

                index = close + 1;
            }
        }
    }

    return -1;
};

/**
 * The next start or end tag at or after `from`. One forward pass, like a browser's tokenizer: a tag runs to its first
 * `>` outside a quoted value, so a page of `<a <a <a …` is read once, not once per `<`. A tag still open at the end of the
 * page ends the search — nothing after it can be a tag.
 */
const nextTag = (html: string, from: number): Tag | undefined => {
    for (let start = html.indexOf("<", from); start !== -1; start = html.indexOf("<", start + 1)) {
        const closing = codeAt(html, start + 1) === 47;
        const nameStart = start + (closing ? 2 : 1);

        if (!isLetter(codeAt(html, nameStart))) {
            continue;
        }

        let nameEnd = nameStart + 1;

        while (isNameChar(codeAt(html, nameEnd))) {
            nameEnd += 1;
        }

        const after = codeAt(html, nameEnd);

        if (!isSpace(after) && after !== 47 && after !== 62) {
            continue;
        }

        const close = endOfTag(html, nameEnd);

        if (close === -1) {
            return undefined;
        }

        return { attributes: html.slice(nameEnd, close), closing, end: close + 1, name: html.slice(nameStart, nameEnd).toLowerCase(), start };
    }

    return undefined;
};

/** The markup of the first element `selector` names, from its start tag to its matching end tag; `undefined` when none. */
export const selectElementHtml = (html: string, selector: SimpleSelector): string | undefined => {
    for (let start = nextTag(html, 0); start !== undefined; start = nextTag(html, start.end)) {
        if (start.closing || !matchesSelector(start.name, start.attributes, selector)) {
            continue;
        }

        if (VOID_ELEMENTS.has(start.name) || start.attributes.endsWith("/")) {
            return html.slice(start.start, start.end);
        }

        // Count same-name tags until the one that closes this element. Every tag is consumed whole, quoted
        // attributes included, so tag-like text inside an attribute value is never read as a tag.
        let depth = 1;

        for (let next = nextTag(html, start.end); next !== undefined; next = nextTag(html, next.end)) {
            if (next.name !== start.name) {
                continue;
            }

            depth += next.closing ? -1 : 1;

            if (depth === 0) {
                return html.slice(start.start, next.end);
            }
        }

        // Never closed: the rest of the page belongs to it.
        return html.slice(start.start);
    }

    return undefined;
};

/** The text a watcher compares, whitespace-collapsed. `undefined` when `selector` matches nothing. */
export const pageComparableText = (html: string, selector?: SimpleSelector): string | undefined => {
    const scope = selector ? selectElementHtml(html, selector) : html;

    return scope === undefined ? undefined : htmlToText(scope).replaceAll(WHITESPACE_RE, " ").trim();
};

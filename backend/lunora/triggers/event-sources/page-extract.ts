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
const TAG_ATTRIBUTES = String.raw`(?:\s(?:"[^"]*"|'[^']*'|[^'">])*)?`;
const START_TAG_RE = new RegExp(`<([a-z][a-z0-9-]*)(${TAG_ATTRIBUTES})/?>`, "giu");
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

/** The markup of the first element `selector` names, from its start tag to its matching end tag; `undefined` when none. */
export const selectElementHtml = (html: string, selector: SimpleSelector): string | undefined => {
    START_TAG_RE.lastIndex = 0;

    for (let start = START_TAG_RE.exec(html); start !== null; start = START_TAG_RE.exec(html)) {
        const tag = start[1]!.toLowerCase();

        if (!matchesSelector(tag, start[2] ?? "", selector)) {
            continue;
        }

        if (VOID_ELEMENTS.has(tag) || start[0].endsWith("/>")) {
            return start[0];
        }

        // Count same-name tags until the one that closes this element. Every tag is consumed whole, quoted
        // attributes included, so tag-like text inside an attribute value is never read as a tag.
        const nested = new RegExp(`<(/?)([a-z][a-z0-9-]*)${TAG_ATTRIBUTES}/?>`, "giu");

        nested.lastIndex = START_TAG_RE.lastIndex;

        let depth = 1;

        for (let next = nested.exec(html); next !== null; next = nested.exec(html)) {
            if (next[2]!.toLowerCase() !== tag) {
                continue;
            }

            depth += next[1] === "/" ? -1 : 1;

            if (depth === 0) {
                return html.slice(start.index, nested.lastIndex);
            }
        }

        // Never closed: the rest of the page belongs to it.
        return html.slice(start.index);
    }

    return undefined;
};

/** The text a watcher compares, whitespace-collapsed. `undefined` when `selector` matches nothing. */
export const pageComparableText = (html: string, selector?: SimpleSelector): string | undefined => {
    const scope = selector ? selectElementHtml(html, selector) : html;

    return scope === undefined ? undefined : htmlToText(scope).replaceAll(WHITESPACE_RE, " ").trim();
};

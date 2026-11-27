/**
 * Reads an EPUB for the preview: its chapters in reading order, and one chapter as a document for a sandboxed frame.
 *
 * The frame is the boundary (`epub-preview.tsx`): no scripts, no same origin, and a content security policy that allows only inline
 * styles and `data:` pictures and fonts, so a chapter can run nothing and reach nothing. Its pictures and style sheets, which the parser
 * hands out as `blob:` addresses of this page, are read here and put in the document itself, so the frame never needs to ask for anything.
 *
 * Two things are not left alone, because a policy limits what a document loads, not where its frame goes or what ends an element:
 * - The chapter is parsed by the browser's own parser before it goes into the document, and every `<meta>` and `<base>` in it is dropped.
 *   A refresh directive moves a frame with no script and outside the policy, and there is no list of its spellings to match: it is closed
 *   by taking out every `<meta>` of the chapter, whatever the markup around it does to the tokenizer.
 * - A book's style sheet is written into a `<style>` element as text that cannot end it, with no `@import` and no address but a `data:`
 *   one (`safeStylesheet`); it never becomes markup.
 */

import type { EpubToc, SpineItem } from "@lingo-reader/epub-parser";

/** The chapter kinds a reader shows; the rest of a spine (a cover image, a style sheet) is not a page of text. */
const READABLE_TYPES: ReadonlySet<string> = new Set(["application/xhtml+xml", "text/html"]);

export interface EpubChapter {
    id: string;
    /** From the book's table of contents, when it names this chapter and no other. */
    title?: string;
}

export interface OpenedEpub {
    /** In the book's reading order. */
    chapters: EpubChapter[];
    destroy: () => void;
    /** Whether `destroy` has been called: a destroyed book is no longer one to read from. */
    readonly destroyed: boolean;
    /** The chapter as a whole document, ready for a frame's `srcdoc`. `signal` stops the reads of its pictures and styles. */
    read: (id: string, signal?: AbortSignal) => Promise<string>;
}

const EPUB_PREFIX = /^epub:/u;
const DOT_SLASH = /^\.\//u;

/** A path in a link without its `epub:` prefix, leading `./` and `#fragment`. */
const pathOf = (href: string): string => (href.replace(EPUB_PREFIX, "").split("#", 1)[0] ?? "").replace(DOT_SLASH, "");

/**
 * The table of contents' labels by spine item. The spine spells a path from the book's root and the table of contents from its own
 * folder, so a label belongs to the spine item whose path ends with the label's whole path (not only its file name: two chapters in
 * different folders can share one). A label that fits more than one item names none of them rather than the wrong one.
 */
const titlesBySpineItem = (toc: EpubToc, spine: ReadonlyArray<SpineItem>): Map<string, string> => {
    const titles = new Map<string, string>();
    const ambiguous = new Set<string>();

    const visit = (points: EpubToc): void => {
        for (const point of points) {
            const target = pathOf(point.href);
            const fits =
                target === "" || point.label === "" ? [] : spine.filter((item) => pathOf(item.href) === target || pathOf(item.href).endsWith(`/${target}`));

            if (fits.length === 1 && fits[0] !== undefined && !titles.has(fits[0].id)) {
                titles.set(fits[0].id, point.label);
            } else if (fits.length > 1) {
                for (const item of fits) {
                    ambiguous.add(item.id);
                }
            }

            if (point.children !== undefined) {
                visit(point.children);
            }
        }
    };

    visit(toc);

    for (const id of ambiguous) {
        titles.delete(id);
    }

    return titles;
};

const BLOB_URL = /blob:[^\s"')<>]+/gu;

const CHUNK = 0x80_00;

/** The most a chapter's inlined pictures and fonts may add to its document, in characters. Past it the rest stay `blob:`, which the policy refuses. */
export const MAX_INLINED_CHARS = 24 * 1024 * 1024;

const mediaTypeOf = (blob: Blob): string => blob.type || "application/octet-stream";

/** The length of the `data:` URL of `blob`, worked out from its size, so a blob that will not fit is never encoded. */
const dataUrlLength = (blob: Blob): number => `data:${mediaTypeOf(blob)};base64,`.length + Math.ceil(blob.size / 3) * 4;

const readAsDataUrl = async (blob: Blob): Promise<string> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";

    for (let at = 0; at < bytes.length; at += CHUNK) {
        binary += String.fromCodePoint(...bytes.subarray(at, at + CHUNK));
    }

    return `data:${mediaTypeOf(blob)};base64,${btoa(binary)}`;
};

/**
 * Every `blob:` address in `text` replaced by the bytes it names. One that cannot be read stays: the frame's policy then blocks it.
 * What the replacements add is bounded (`shared`: one budget for a chapter's styles and markup). The cost of an address is its data URL
 * times how often it appears, taken from the blob's size BEFORE it is converted, so one that will not fit is never encoded; and the
 * addresses are read one at a time, so a chapter with many of them never holds them all at once.
 */
export const inlineBlobUrls = async (text: string, signal?: AbortSignal, shared?: { left: number }): Promise<string> => {
    const budget = shared ?? { left: MAX_INLINED_CHARS };
    const counts = new Map<string, number>();

    const found = text.match(BLOB_URL) ?? [];

    for (const url of found) {
        counts.set(url, (counts.get(url) ?? 0) + 1);
    }

    const inlined = new Map<string, string>();

    for (const [url, times] of counts) {
        try {
            const response = await fetch(url, { signal });
            const blob = await response.blob();
            const cost = dataUrlLength(blob) * times;

            if (cost <= budget.left) {
                inlined.set(url, await readAsDataUrl(blob));
                budget.left -= cost;
            }
        } catch {
            // Left as it is.
        }
    }

    return text.replaceAll(BLOB_URL, (url) => inlined.get(url) ?? url);
};

/**
 * What the frame may load: nothing by itself, only styles written in the document and pictures or fonts carried in it. Scripts, frames,
 * forms, connections and every other address are refused. The frame's `sandbox` is the first wall and this the second, for a request
 * a chapter's markup could still make without a script (a picture or style sheet from another site).
 */
export const FRAME_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

const CSS_IMPORT = /@import\b[^;{]*;?/giu;
const CSS_URL = /url\(([^)]*)\)/giu;
const CSS_QUOTE = /^["']|["']$/gu;
const CSS_SCRIPTY = /expression\s*\(|-moz-binding\s*:|behaviou?r\s*:/giu;
const LESS_THAN = /</gu;

/**
 * A book's style sheet as text for a `<style>` element: no `@import`, no `url()` that is not a `data:` one (it is made empty), no
 * `expression(`, `behavior:` or `-moz-binding:` (old engines ran script from them), and every `<` as the CSS escape `\3c `, so nothing in it
 * can end the element or begin markup. An ordinary sheet is otherwise as it was.
 */
const dataOnly = (match: string, argument: string): string => {
    const address = argument.trim().replaceAll(CSS_QUOTE, "").trim().toLowerCase();

    return address.startsWith("data:") ? match : 'url("")';
};

export const safeStylesheet = (css: string): string => {
    const withoutImports = css.replaceAll(CSS_IMPORT, "");
    const dataUrlsOnly = withoutImports.replaceAll(CSS_URL, (match, argument: string) => dataOnly(match, argument));

    return dataUrlsOnly.replaceAll(CSS_SCRIPTY, "blocked:").replaceAll(LESS_THAN, String.raw`\3c `);
};

const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;

const BASE_STYLE = "body{font-family:system-ui,sans-serif;line-height:1.6;margin:1rem;overflow-wrap:anywhere}img,svg,video{max-width:100%;height:auto}";

/**
 * A chapter's markup as a whole document. The markup is parsed first by the browser's parser, in a document of its own that loads and runs
 * nothing, and its `<meta>` and `<base>` elements are dropped (a refresh directive, or a base that would move its links). The policy
 * comes first in the head, ahead of anything the chapter or its styles add. A link in it opens nowhere (`target` with no popups allowed).
 */
export const chapterDocument = (body: string, styles: ReadonlyArray<string>, language?: string): string => {
    const frame = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");

    frame.body.innerHTML = body;

    for (const element of frame.querySelectorAll("meta, base")) {
        element.remove();
    }

    const make = (tag: string, attributes: Record<string, string> = {}, text?: string): HTMLElement => {
        const element = frame.createElement(tag);

        for (const [name, value] of Object.entries(attributes)) {
            element.setAttribute(name, value);
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    };

    const head: Node[] = [
        // eslint-disable-next-line unicorn/text-encoding-identifier-case -- the HTML label; `utf8` is not the one a document names
        make("meta", { charset: "utf-8" }),
        make("meta", { content: FRAME_POLICY, "http-equiv": "Content-Security-Policy" }),
        make("base", { target: "_blank" }),
        make("style", {}, BASE_STYLE),
        ...styles.map((style) => make("style", {}, safeStylesheet(style))),
    ];

    for (const node of head) {
        frame.head.append(node);
    }

    if (language !== undefined && LANGUAGE.test(language)) {
        frame.documentElement.setAttribute("lang", language);
    }

    return `<!doctype html>${frame.documentElement.outerHTML}`;
};

export const openEpub = async (bytes: Uint8Array, resourceSaveDirectory?: string): Promise<OpenedEpub> => {
    const { initEpubFile } = await import("@lingo-reader/epub-parser");
    const book = await initEpubFile(bytes, resourceSaveDirectory);
    const spine = book.getSpine().filter((item) => READABLE_TYPES.has(item.mediaType));
    const titles = titlesBySpineItem(book.getToc(), spine);
    const { language } = book.getMetadata();
    let isDestroyed = false;

    return {
        chapters: spine.map((item): EpubChapter => {
            const title = titles.get(item.id);

            return { id: item.id, ...(title !== undefined && { title }) };
        }),
        // Once, whoever asks: a failed preview destroys the book itself and its unmount cleanup may ask again.
        destroy: () => {
            if (isDestroyed) {
                return;
            }

            isDestroyed = true;
            book.destroy();
        },
        get destroyed() {
            return isDestroyed;
        },
        read: async (id, signal) => {
            const { css, html } = await book.loadChapter(id);
            // One budget for the chapter: its styles and its markup together.
            const budget = { left: MAX_INLINED_CHARS };
            const styles: string[] = [];

            for (const part of css) {
                try {
                    const response = await fetch(part.href, { signal });
                    const text = await response.text();

                    styles.push(await inlineBlobUrls(text, signal, budget));
                } catch {
                    styles.push("");
                }
            }

            return chapterDocument(await inlineBlobUrls(html, signal, budget), styles, language);
        },
    };
};

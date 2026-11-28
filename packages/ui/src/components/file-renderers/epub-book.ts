/**
 * Reads an EPUB for the preview: its chapters in reading order, and one chapter as a document for a sandboxed frame.
 *
 * The parser (`@lingo-reader/epub-parser`) gives the book's structure only: spine, table of contents, language. A chapter is read from
 * the archive here, not through the parser's `loadChapter`: that one turns a book's pictures and styles into `blob:` addresses kept in a
 * cache shared by every open book (a second book's `cover.png` can be the first's) and released only by a global revoke. Reading them here
 * creates no object URL at all, so nothing is shared between books and nothing is left to revoke when one closes.
 *
 * The frame is the boundary (`epub-preview.tsx`): no scripts, no same origin, and a content security policy that allows only inline
 * styles and `data:` pictures and fonts. A chapter's pictures and styles are read one at a time, within a budget, and written into its
 * document as `data:` URLs and text, so the frame never needs to ask for anything. Because a policy limits what a document loads, not where
 * its frame goes or what ends an element, the chapter is also not trusted as markup: see `chapterDocument`.
 */

import type { EpubToc, SpineItem } from "@lingo-reader/epub-parser";
import JSZip from "jszip";

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
    /** The chapter as a whole document, ready for a frame's `srcdoc`. `signal` stops the reads that are still to come. */
    read: (id: string, signal?: AbortSignal) => Promise<string>;
}

const EPUB_PREFIX = /^epub:/u;
const DOT_SLASH = /^\.\//u;

/** A path in a link without its `epub:` prefix, leading `./` and `#fragment`. */
const pathOf = (href: string): string => {
    const bare = (href.replace(EPUB_PREFIX, "").split("#", 1)[0] ?? "").replace(DOT_SLASH, "");

    try {
        // A name written with escapes (`my%20chapter.xhtml`) is the file stored under its plain name.
        return decodeURIComponent(bare);
    } catch {
        return bare;
    }
};

/**
 * The table of contents' labels by spine item. The spine spells a path from the book's root and the table of contents from its own folder,
 * so a label belongs to the spine item whose path ends with the label's whole path (not only its file name: two chapters in different
 * folders can share one). The spine is indexed ONCE by every tail of every item's path, so each entry is a lookup, not a scan of the spine.
 * A label that fits more than one item names none of them rather than the wrong one.
 */
const titlesBySpineItem = (toc: EpubToc, spine: ReadonlyArray<SpineItem>): Map<string, string> => {
    const byTail = new Map<string, Set<string>>();

    for (const item of spine) {
        const parts = pathOf(item.href).split("/");

        for (let from = 0; from < parts.length; from += 1) {
            const tail = parts.slice(from).join("/");
            const ids = byTail.get(tail) ?? new Set<string>();

            ids.add(item.id);
            byTail.set(tail, ids);
        }
    }

    const titles = new Map<string, string>();
    const ambiguous = new Set<string>();

    const visit = (points: EpubToc): void => {
        for (const point of points) {
            const fits = point.label === "" ? undefined : byTail.get(pathOf(point.href));

            if (fits?.size === 1) {
                const [id] = fits;

                if (id !== undefined && !titles.has(id)) {
                    titles.set(id, point.label);
                }
            } else if (fits !== undefined) {
                for (const id of fits) {
                    ambiguous.add(id);
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

/** The most a chapter's inlined pictures, fonts and style sheets may add to its document, in characters. Past it the rest are left out. */
export const MAX_INLINED_CHARS = 24 * 1024 * 1024;

/** The most a chapter's own markup may be, in characters: a file past it is not parsed. */
export const MAX_CHAPTER_CHARS = 8 * 1024 * 1024;

/** The most distinct files one chapter may inline. A chapter that names more has the rest left out, so a book cannot make a reader read without end. */
export const MAX_ASSETS_PER_CHAPTER = 200;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    otf: "font/otf",
    png: "image/png",
    svg: "image/svg+xml",
    ttf: "font/ttf",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
};

const CHUNK = 0x80_00;

const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (let at = 0; at < bytes.length; at += CHUNK) {
        binary += String.fromCodePoint(...bytes.subarray(at, at + CHUNK));
    }

    return btoa(binary);
};

const SCHEME = /^[a-z][a-z\d+.-]*:/iu;
const QUERY_OR_FRAGMENT = /[#?]/u;

/** `reference` (a path in a chapter or a style sheet) as a path from the archive's root, or `undefined` for an address that is not a path in it. */
const resolveInArchive = (reference: string, fromDirectory: string): string | undefined => {
    const bare = reference.split(QUERY_OR_FRAGMENT, 1)[0]?.trim() ?? "";

    if (bare === "" || SCHEME.test(bare) || bare.startsWith("//")) {
        return undefined;
    }

    let decoded = bare;

    try {
        decoded = decodeURIComponent(bare);
    } catch {
        // Kept as written.
    }

    const parts: string[] = bare.startsWith("/") ? [] : fromDirectory.split("/").filter(Boolean);

    for (const part of decoded.split("/")) {
        if (part === "..") {
            parts.pop();
        } else if (part !== "." && part !== "") {
            parts.push(part);
        }
    }

    return parts.join("/");
};

const directoryOf = (path: string): string => path.split("/").slice(0, -1).join("/");

const extensionOf = (path: string): string => path.split(".").pop()?.toLowerCase() ?? "";

/** What a chapter's reads draw on: one budget for its styles and its markup, a count of distinct files, and a reader of the archive. */
interface AssetReader {
    budget: { files: number; left: number };
    /** A file as a `data:` URL, or `undefined` when it is not in the archive, does not fit the budget or the count, or is not a kind that is inlined. */
    dataUrl: (path: string) => Promise<string | undefined>;
    /** Whether `length` characters could still be spent (without spending them). */
    fits: (length: number) => boolean;
    /** Whether the chapter may still take another file at all (some budget and some count left): asked before a file is read. */
    mayRead: () => boolean;
    /** Whether a style sheet has been refused for size or count: the chapter then reads no further sheet. */
    refused: () => boolean;
    /** The size of a file as the archive's directory declares it, when it does; read before the file is, so one too big is never opened. */
    size: (path: string) => number | undefined;
    /** Charges a text that is to go into the document (a style sheet, after its addresses are rewritten) to the budget and the count; `false` when it does not fit. */
    spend: (length: number) => boolean;
    /** As `spend`, for a sheet whose `data:` pictures were already charged when they were read: only the rest of its text is charged now. */
    spendSheet: (length: number) => boolean;
    /** A text file of the archive. */
    text: (path: string) => Promise<string | undefined>;
}

const assetReader = (zip: JSZip, signal?: AbortSignal): AssetReader => {
    const budget = { files: MAX_ASSETS_PER_CHAPTER, left: MAX_INLINED_CHARS };
    let refusedSheet = false;
    // The cost of pictures already counted against a sheet: they are charged once, when read, not again as part of the sheet.
    let pictureCharged = 0;
    let attributed = 0;
    // What each file became, and what it costs each time it is written into the document.
    const seen = new Map<string, { cost: number; url: string } | undefined>();

    return {
        budget,
        dataUrl: async (path) => {
            signal?.throwIfAborted();

            if (seen.has(path)) {
                const cached = seen.get(path);

                // Every copy the document carries is charged, the first or not: a picture used many times cannot grow it past the budget.
                if (cached === undefined || cached.cost > budget.left) {
                    return undefined;
                }

                budget.left -= cached.cost;
                pictureCharged += cached.cost;

                return cached.url;
            }

            const type = MEDIA_TYPES[extensionOf(path)];
            const entry = type === undefined ? null : zip.file(path);

            if (entry === null || type === undefined || budget.files <= 0 || budget.left <= 0) {
                seen.set(path, undefined);

                return undefined;
            }

            budget.files -= 1;

            const bytes = await entry.async("uint8array");
            // From the size, before the encoding: one that will not fit is never encoded.
            const length = `data:${type};base64,`.length + Math.ceil(bytes.length / 3) * 4;

            if (length > budget.left) {
                seen.set(path, undefined);

                return undefined;
            }

            budget.left -= length;
            pictureCharged += length;

            const url = `data:${type};base64,${toBase64(bytes)}`;

            seen.set(path, { cost: length, url });

            return url;
        },
        fits: (length) => budget.files > 0 && length <= budget.left,
        mayRead: () => budget.files > 0 && budget.left > 0 && !refusedSheet,
        refused: () => refusedSheet,
        size: (path) => (zip.file(path) as { _data?: { uncompressedSize?: number } } | null)?._data?.uncompressedSize,
        spend: (length) => {
            if (budget.files <= 0 || length > budget.left) {
                refusedSheet = true;

                return false;
            }

            budget.files -= 1;
            budget.left -= length;

            return true;
        },
        spendSheet: (length) => {
            // The pictures a sheet carries were charged as they were read; only the rest of its text is charged now.
            const inlined = pictureCharged - attributed;
            const rest = Math.max(0, length - inlined);

            if (budget.files <= 0 || rest > budget.left) {
                refusedSheet = true;

                return false;
            }

            attributed = pictureCharged;
            budget.files -= 1;
            budget.left -= rest;

            return true;
        },
        text: async (path) => {
            signal?.throwIfAborted();

            return (await zip.file(path)?.async("string")) ?? undefined;
        },
    };
};

const CSS_IMPORT = /@import\b[^;{]*;?/giu;
const CSS_URL = /url\(([^)]*)\)/giu;
const CSS_QUOTE = /^["']|["']$/gu;
const CSS_SCRIPTY = /expression\s*\(|-moz-binding\s*:|behaviou?r\s*:/giu;
const LESS_THAN = /</gu;

const isDataUrl = (address: string): boolean => address.trim().replaceAll(CSS_QUOTE, "").trim().toLowerCase().startsWith("data:");

const dataOnly = (match: string, argument: string): string => (isDataUrl(argument) ? match : 'url("")');

/**
 * A book's style sheet as text for a `<style>` element: no `@import`, no `url()` that is not a `data:` one (it is made empty), no
 * `expression(`, `behavior:` or `-moz-binding:` (old engines ran script from them), and every `<` as the CSS escape `\3c `, so nothing in it
 * can end the element or begin markup. An ordinary sheet is otherwise as it was.
 */
export const safeStylesheet = (css: string): string => {
    const withoutImports = css.replaceAll(CSS_IMPORT, "");
    const dataUrlsOnly = withoutImports.replaceAll(CSS_URL, (match, argument: string) => dataOnly(match, argument));

    return dataUrlsOnly.replaceAll(CSS_SCRIPTY, "blocked:").replaceAll(LESS_THAN, String.raw`\3c `);
};

/** A style sheet's relative `url()`s replaced by the files they name, within the chapter's budget; the rest are left for `safeStylesheet` to empty. */
const inlineStylesheetUrls = async (css: string, directory: string, reader: AssetReader): Promise<string> => {
    // One answer per OCCURRENCE, in order: a file named many times is written many times, so it is charged each time (`dataUrl` charges a copy
    // it already has as it does the first), and once the budget is spent the rest of the occurrences are left as they were.
    const found = [...css.matchAll(CSS_URL)].map((match) => match[1] ?? "");
    const answers: (string | undefined)[] = [];

    for (const argument of found) {
        const path = resolveInArchive(argument.trim().replaceAll(CSS_QUOTE, "").trim(), directory);

        answers.push(path === undefined ? undefined : await reader.dataUrl(path));
    }

    let at = 0;

    return css.replaceAll(CSS_URL, (match) => {
        const url = answers[at];

        at += 1;

        return url === undefined ? match : `url("${url}")`;
    });
};

/**
 * What the frame may load: nothing by itself, only styles written in the document and pictures or fonts carried in it. Scripts, frames,
 * forms, connections and every other address are refused. The frame's `sandbox` is the first wall and this the second, for a request
 * a chapter's markup could still make without a script (a picture or style sheet from another site).
 */
export const FRAME_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;

const BASE_STYLE = "body{font-family:system-ui,sans-serif;line-height:1.6;margin:1rem;overflow-wrap:anywhere}img,svg,video{max-width:100%;height:auto}";

/** Attributes that make a browser request something by themselves, and so may hold nothing but a `data:` address (or, for an SVG reference, a `#` one). */
const LOADING_ATTRIBUTES: ReadonlyArray<string> = ["action", "background", "data", "formaction", "ping", "poster", "src", "srcset"];
const REFERENCE_ATTRIBUTES: ReadonlyArray<string> = ["href", "xlink:href"];
/** Elements that load or frame another document: none is wanted in a chapter, and the policy refuses what they would load. */
const EMBEDDING_ELEMENTS = "iframe, frame, frameset, object, embed, link";
/** Elements a walk of the markup does not enter or that rewrite an attribute after the document is loaded: a template's content is a separate fragment (a declarative shadow root renders it), and SVG animation can set an `href` or `target` later. */
const DEFERRING_ELEMENTS = "template, set, animate, animatetransform, animatemotion";
const SPLIT_CANDIDATE = /[\s,]+/u;
const SELF_CONTAINED = /^\s*(?:data:|#)/iu;
const SINGLE_DATA_CANDIDATE = /^\s*data:\S*(?:\s+[\d.]+[wx])?\s*$/iu;

/**
 * Takes out of parsed chapter markup what could reach beyond it: every `<meta>` and `<base>` (a refresh directive moves a frame with no script
 * and there is no list of its spellings to match, so none is kept); the elements that embed another document; every attribute that loads
 * something unless it holds a `data:` address; and the cleaning of `style` attributes and `<style>` elements. An anchor keeps its `href`, which
 * goes nowhere, and every explicit `target` of an anchor or area becomes `_blank`, which a frame with no popups allowed opens nowhere.
 */
const neutralize = (root: Element): void => {
    for (const element of root.querySelectorAll("meta, base")) {
        element.remove();
    }

    for (const element of root.querySelectorAll(`${EMBEDDING_ELEMENTS}, ${DEFERRING_ELEMENTS}`)) {
        element.remove();
    }

    for (const element of root.querySelectorAll("*")) {
        for (const name of LOADING_ATTRIBUTES) {
            if (element.hasAttribute(name) && !SELF_CONTAINED.test(element.getAttribute(name) ?? "")) {
                element.removeAttribute(name);
            }
        }

        // A `srcset` is a list: it starts with a data address and may still name others after it, so it stays only as one data candidate.
        for (const name of ["imagesrcset", "srcset"]) {
            if (element.hasAttribute(name) && !SINGLE_DATA_CANDIDATE.test(element.getAttribute(name) ?? "")) {
                element.removeAttribute(name);
            }
        }

        if (element.localName !== "a" && element.localName !== "area") {
            for (const name of REFERENCE_ATTRIBUTES) {
                if (element.hasAttribute(name) && !SELF_CONTAINED.test(element.getAttribute(name) ?? "")) {
                    element.removeAttribute(name);
                }
            }
        }

        if (element.localName === "a" || element.localName === "area") {
            // A link to a place in the chapter (a footnote, a note's way back) moves within the frame, which loads nothing; any other goes nowhere.
            element.setAttribute("target", (element.getAttribute("href") ?? "").trimStart().startsWith("#") ? "_self" : "_blank");
            element.setAttribute("rel", "noopener noreferrer");
        }

        const style = element.getAttribute("style");

        if (style !== null) {
            element.setAttribute("style", safeStylesheet(style));
        }

        if (element.localName === "style") {
            element.textContent = safeStylesheet(element.textContent ?? "");
        }
    }
};

/**
 * A chapter's markup as a whole document. The policy is the first element of the head, written before any of the chapter is; the markup is
 * then parsed by the browser's own parser in a document of its own that loads and runs nothing, neutralized (`neutralize`), and only then moved
 * into the document. The book's styles follow the policy as inert text (`safeStylesheet`).
 */
export const chapterDocument = (markup: string, styles: ReadonlyArray<string>, language?: string): string => {
    const frame = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");

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

    // The head first, the policy first in it: before any markup of the chapter is written into the document.
    const head: Node[] = [
        make("meta", { content: FRAME_POLICY, "http-equiv": "Content-Security-Policy" }),
        // eslint-disable-next-line unicorn/text-encoding-identifier-case -- the HTML label; `utf8` is not the one a document names
        make("meta", { charset: "utf-8" }),
        make("base", { target: "_blank" }),
        make("style", {}, BASE_STYLE),
        ...styles.map((style) => make("style", {}, safeStylesheet(style))),
    ];

    for (const node of head) {
        // `appendChild`: `append` is typed for a worker's HTML rewriter in the projects that type this file with the Workers library.

        frame.head.appendChild(node);
    }

    if (language !== undefined && LANGUAGE.test(language)) {
        frame.documentElement.setAttribute("lang", language);
    }

    const chapter = new DOMParser().parseFromString(`<!doctype html><html><body>${markup}</body></html>`, "text/html");

    neutralize(chapter.body);

    for (const node of chapter.body.childNodes) {
        frame.body.appendChild(frame.importNode(node, true));
    }

    return `<!doctype html>${frame.documentElement.outerHTML}`;
};

const countLessThan = (text: string): number => {
    let count = 0;

    for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
        count += 1;
    }

    return count;
};

/** A chapter read from the archive: its markup with its pictures inlined, and its styles, in the order the chapter names them. */

/**
 * A chapter's markup as an HTML document. A chapter is XHTML: it is read as XML first, so a self-closing `<span/>` or `<title/>` means what it
 * says, and moved into an HTML document (which serializes as HTML, where `<div/>` would open a div); one that is not well-formed XML is read
 * as HTML, as a browser would.
 */
const parseChapter = (source: string): Document => {
    const html = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
    const xml = new DOMParser().parseFromString(source, "application/xhtml+xml");

    if (xml.querySelector("parsererror") !== null || xml.documentElement.localName !== "html") {
        return new DOMParser().parseFromString(source, "text/html");
    }

    for (const [from, to] of [
        [xml.querySelector("head"), html.head],
        [xml.querySelector("body"), html.body],
    ] as const) {
        const children = [...(from?.childNodes ?? [])];

        for (const node of children) {
            to.appendChild(html.importNode(node, true));
        }
    }

    return html;
};

const readChapter = async (chapterPath: string, reader: AssetReader): Promise<{ markup: string; styles: string[] }> => {
    const source = await reader.text(chapterPath);

    if (source === undefined) {
        throw new Error("chapter not found");
    }

    if (source.length > MAX_CHAPTER_CHARS) {
        throw new Error("chapter too large");
    }

    const directory = directoryOf(chapterPath);
    const parsed = parseChapter(source);
    const styles: string[] = [];

    for (const link of parsed.querySelectorAll('link[rel~="stylesheet" i][href]')) {
        // Asked before the file is read: with the budget or the count spent, no further sheet is even opened.
        if (!reader.mayRead()) {
            break;
        }

        const path = resolveInArchive(link.getAttribute("href") ?? "", directory);
        const declared = path === undefined ? undefined : reader.size(path);

        // A sheet whose declared size cannot fit is refused whole before it is read or rewritten: the rewrite can only make it longer.
        if (declared !== undefined && !reader.fits(declared)) {
            reader.spendSheet(Infinity);

            break;
        }

        const text = path === undefined ? undefined : await reader.text(path);

        if (path !== undefined && text !== undefined && !reader.fits(text.length)) {
            reader.spendSheet(Infinity);

            break;
        }

        if (path !== undefined && text !== undefined) {
            // What cleaning can make of it, worked out before anything is rewritten: every `<` becomes four characters.
            if (!reader.fits(text.length + 3 * countLessThan(text))) {
                reader.spendSheet(Infinity);

                break;
            }

            // Cleaned FIRST, and the exact text that will be written is what is charged; the document does not clean it again by growing it.
            const sheet = safeStylesheet(await inlineStylesheetUrls(text, directoryOf(path), reader));

            // A sheet that does not fit is left out whole, not cut: half a sheet would style a chapter wrongly.
            if (reader.spendSheet(sheet.length)) {
                styles.push(sheet);
            }
        }
    }

    for (const style of parsed.querySelectorAll("style")) {
        const inHead = style.closest("head") !== null;

        // After a sheet was refused for size or count, no further one is attempted: the rejection work is not repeated for each.
        if (reader.refused()) {
            style.textContent = "";

            continue;
        }

        const own = style.textContent ?? "";

        if (!reader.fits(own.length + 3 * countLessThan(own))) {
            reader.spendSheet(Infinity);
            style.textContent = "";

            continue;
        }

        const sheet = safeStylesheet(await inlineStylesheetUrls(own, directory, reader));
        const kept = reader.spendSheet(sheet.length) ? sheet : "";

        if (inHead) {
            // A rule the chapter defines in its head (`p { white-space: pre-wrap }`) is kept, rewritten and charged like any sheet, and goes
            // where the others go: only the body is the chapter's markup.
            if (kept !== "") {
                styles.push(kept);
            }
        } else {
            style.textContent = kept;
        }
    }

    for (const element of parsed.body.querySelectorAll("img[src], source[src], video[poster], image, input[src], audio[src]")) {
        for (const name of ["src", "poster", "href", "xlink:href"]) {
            const value = element.getAttribute(name);
            const path = value === null ? undefined : resolveInArchive(value, directory);
            const url = path === undefined ? undefined : await reader.dataUrl(path);

            if (url !== undefined) {
                element.setAttribute(name, url);
            }
        }
    }

    // A picture an inline `style` names, and the first candidate of a `srcset` an `img` has no `src` beside.
    for (const element of parsed.body.querySelectorAll("[style], img[srcset]:not([src])")) {
        const style = element.getAttribute("style");

        if (style !== null && style.includes("url(") && !reader.refused()) {
            element.setAttribute("style", await inlineStylesheetUrls(style, directory, reader));
        }

        const first = element.localName === "img" ? element.getAttribute("srcset")?.trim().split(SPLIT_CANDIDATE, 1)[0] : undefined;
        const path = first === undefined ? undefined : resolveInArchive(first, directory);
        const url = path === undefined ? undefined : await reader.dataUrl(path);

        if (url !== undefined) {
            element.setAttribute("src", url);
        }
    }

    // eslint-disable-next-line unicorn/prefer-dom-node-html-methods -- `getHTML` is not in every engine this runs in (nor in jsdom)
    return { markup: parsed.body.innerHTML, styles };
};

/** Books opened so far: each gets a folder of its own for the parser, so two books never write over each other. */
const opened = { count: 0 };

export const openEpub = async (bytes: Uint8Array, resourceSaveDirectory?: string): Promise<OpenedEpub> => {
    const [{ initEpubFile }, zip] = await Promise.all([import("@lingo-reader/epub-parser"), JSZip.loadAsync(bytes)]);
    // The parser reads the structure only; it is given a folder of its own (its default is shared by every book on the page).
    const book = await initEpubFile(bytes, resourceSaveDirectory ?? `./epub-${String(++opened.count)}`);
    const spine = book.getSpine().filter((item) => READABLE_TYPES.has(item.mediaType));
    const titles = titlesBySpineItem(book.getToc(), spine);
    const pathById = new Map(spine.map((item) => [item.id, pathOf(item.href)]));
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
            const chapterPath = pathById.get(id);

            if (chapterPath === undefined) {
                throw new Error("unknown chapter");
            }

            const reader = assetReader(zip, signal);
            const { markup, styles } = await readChapter(chapterPath, reader);

            return chapterDocument(markup, styles, language);
        },
    };
};

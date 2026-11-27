/**
 * Reads an EPUB for the preview: its chapters in reading order, and one chapter as a document for a sandboxed frame.
 *
 * The chapter's markup is NOT cleaned here. The frame is the boundary (`epub-preview.tsx`): no scripts, no same origin, and a
 * content security policy that allows only inline styles and `data:` images, so a chapter can run nothing and reach nothing.
 * Its pictures and style sheets, which the parser hands out as `blob:` addresses of this page, are read here and put in the
 * document itself, so the frame never needs to ask for anything. Two narrow exceptions to leaving the markup alone are named below
 * (`withoutRefresh`, the document's `lang`).
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
    /** The chapter as a whole document, ready for a frame's `srcdoc`. `signal` stops the reads of its pictures and styles. */
    read: (id: string, signal?: AbortSignal) => Promise<string>;
}

const EPUB_PREFIX = /^epub:/u;

/** A path in a link without its `epub:` prefix, leading `./` and `#fragment`. */
const DOT_SLASH = /^\.\//u;

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

const readAsDataUrl = async (url: string, signal?: AbortSignal): Promise<string> => {
    const response = await fetch(url, { signal });
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";

    for (let at = 0; at < bytes.length; at += CHUNK) {
        binary += String.fromCodePoint(...bytes.subarray(at, at + CHUNK));
    }

    return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
};

/**
 * Every `blob:` address in `text` replaced by the bytes it names. One that cannot be read stays: the frame's policy then blocks it.
 * What the replacements add is bounded (`budget`, shared by a chapter's styles and markup): an address repeated many times cannot grow
 * the document past it, and once it is spent the rest stay as they are.
 */
export const inlineBlobUrls = async (text: string, signal?: AbortSignal, shared?: { left: number }): Promise<string> => {
    const budget = shared ?? { left: MAX_INLINED_CHARS };
    const urls = [...new Set(text.match(BLOB_URL))];
    const inlined = new Map<string, string>();

    await Promise.all(
        urls.map(async (url) => {
            try {
                inlined.set(url, await readAsDataUrl(url, signal));
            } catch {
                // Left as it is.
            }
        }),
    );

    return text.replaceAll(BLOB_URL, (url) => {
        const data = inlined.get(url);

        if (data === undefined || data.length > budget.left) {
            return url;
        }

        budget.left -= data.length;

        return data;
    });
};

/**
 * What the frame may load: nothing by itself, only styles written in the document and pictures or fonts carried in it. Scripts, frames,
 * forms, connections and every other address are refused. The frame's `sandbox` is the first wall and this the second, for a request
 * a chapter's markup could still make without a script (a picture or style sheet from another site).
 */
export const FRAME_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

const META_REFRESH = /<meta\s[^>]*?http-equiv\s*=\s*["']?refresh[^>]*>/giu;

/**
 * A `<meta http-equiv="refresh">` moves a frame to another address with no click and no script, outside the policy above (a policy limits
 * what a document loads, not where a frame goes). It is the one navigation a chapter can make by itself, so it is taken out; a link a
 * person clicks is left, and goes nowhere (`target`, below).
 */
const withoutRefresh = (body: string): string => body.replaceAll(META_REFRESH, "");

const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;

/** A chapter's markup as a document. A link in it opens nowhere (`target` with no popups allowed), so it cannot move the frame to a site. */
export const chapterDocument = (body: string, styles: ReadonlyArray<string>, language?: string): string =>
    `<!doctype html><html${language !== undefined && LANGUAGE.test(language) ? ` lang="${language}"` : ""}><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><base target="_blank">` +
    `<style>body{font-family:system-ui,sans-serif;line-height:1.6;margin:1rem;overflow-wrap:anywhere}img,svg,video{max-width:100%;height:auto}</style>` +
    `${styles.map((style) => `<style>${style}</style>`).join("")}</head><body>${withoutRefresh(body)}</body></html>`;

export const openEpub = async (bytes: Uint8Array, resourceSaveDirectory?: string): Promise<OpenedEpub> => {
    const { initEpubFile } = await import("@lingo-reader/epub-parser");
    const book = await initEpubFile(bytes, resourceSaveDirectory);
    const spine = book.getSpine().filter((item) => READABLE_TYPES.has(item.mediaType));
    const titles = titlesBySpineItem(book.getToc(), spine);
    const { language } = book.getMetadata();
    let destroyed = false;

    return {
        chapters: spine.map((item): EpubChapter => {
            const title = titles.get(item.id);

            return { id: item.id, ...(title !== undefined && { title }) };
        }),
        // Once, whoever asks: a failed preview destroys the book itself and its unmount cleanup may ask again.
        destroy: () => {
            if (destroyed) {
                return;
            }

            destroyed = true;
            book.destroy();
        },
        read: async (id, signal) => {
            const { css, html } = await book.loadChapter(id);
            // One budget for the chapter: its styles and its markup together.
            const budget = { left: MAX_INLINED_CHARS };
            const styles = await Promise.all(
                css.map(async (part) => {
                    try {
                        const response = await fetch(part.href, { signal });
                        const text = await response.text();

                        return await inlineBlobUrls(text, signal, budget);
                    } catch {
                        return "";
                    }
                }),
            );

            return chapterDocument(await inlineBlobUrls(html, signal, budget), styles, language);
        },
    };
};

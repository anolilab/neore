/**
 * Reads an EPUB for the preview: its chapters in reading order, and one chapter as a document for a sandboxed frame.
 *
 * The chapter's markup is NOT cleaned here. The frame is the boundary (`epub-preview.tsx`): no scripts, no same origin, and a
 * content security policy that allows only inline styles and `data:` images, so a chapter can run nothing and reach nothing.
 * Its pictures and style sheets, which the parser hands out as `blob:` addresses of this page, are read here and put in the
 * document itself, so the frame never needs to ask for anything.
 */

import type { EpubToc } from "@lingo-reader/epub-parser";

/** The chapter kinds a reader shows; the rest of a spine (a cover image, a style sheet) is not a page of text. */
const READABLE_TYPES: ReadonlySet<string> = new Set(["application/xhtml+xml", "text/html"]);

export interface EpubChapter {
    id: string;
    /** From the book's table of contents, when it names this chapter. */
    title?: string;
}

export interface OpenedEpub {
    /** In the book's reading order. */
    chapters: EpubChapter[];
    destroy: () => void;
    /** The chapter as a whole document, ready for a frame's `srcdoc`. */
    read: (id: string) => Promise<string>;
}

const EPUB_PREFIX = /^epub:/u;

/** A file's own name in a link, without its folders or `#fragment`: the spine and the table of contents spell paths from different roots. */
const baseName = (href: string): string => (href.replace(EPUB_PREFIX, "").split("#", 1)[0] ?? "").split("/").pop() ?? "";

const titlesByFile = (toc: EpubToc, into = new Map<string, string>()): Map<string, string> => {
    for (const point of toc) {
        const name = baseName(point.href);

        if (name !== "" && point.label !== "" && !into.has(name)) {
            into.set(name, point.label);
        }

        if (point.children !== undefined) {
            titlesByFile(point.children, into);
        }
    }

    return into;
};

const BLOB_URL = /blob:[^\s"')<>]+/gu;

const CHUNK = 0x80_00;

const readAsDataUrl = async (url: string): Promise<string> => {
    const response = await fetch(url);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";

    for (let at = 0; at < bytes.length; at += CHUNK) {
        binary += String.fromCodePoint(...bytes.subarray(at, at + CHUNK));
    }

    return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
};

/** Every `blob:` address in `text` replaced by the bytes it names. One that cannot be read stays: the frame's policy then blocks it. */
export const inlineBlobUrls = async (text: string): Promise<string> => {
    const urls = [...new Set(text.match(BLOB_URL))];
    const inlined = new Map<string, string>();

    await Promise.all(
        urls.map(async (url) => {
            try {
                inlined.set(url, await readAsDataUrl(url));
            } catch {
                // Left as it is.
            }
        }),
    );

    return text.replaceAll(BLOB_URL, (url) => inlined.get(url) ?? url);
};

/**
 * What the frame may load: nothing by itself, only styles written in the document and pictures or fonts carried in it. Scripts, frames,
 * forms, connections and every other address are refused. The frame's `sandbox` is the first wall and this the second, for a request
 * a chapter's markup could still make without a script (a picture or style sheet from another site).
 */
export const FRAME_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** A chapter's markup as a document. A link in it opens nowhere (`target` with no popups allowed), so it cannot move the frame to a site. */
export const chapterDocument = (body: string, styles: ReadonlyArray<string>): string =>
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><base target="_blank">` +
    `<style>body{font-family:system-ui,sans-serif;line-height:1.6;margin:1rem;overflow-wrap:anywhere}img,svg,video{max-width:100%;height:auto}</style>` +
    `${styles.map((style) => `<style>${style}</style>`).join("")}</head><body>${body}</body></html>`;

export const openEpub = async (bytes: Uint8Array, resourceSaveDirectory?: string): Promise<OpenedEpub> => {
    const { initEpubFile } = await import("@lingo-reader/epub-parser");
    const book = await initEpubFile(bytes, resourceSaveDirectory);
    const titles = titlesByFile(book.getToc());
    const chapters = book
        .getSpine()
        .filter((item) => READABLE_TYPES.has(item.mediaType))
        .map((item): EpubChapter => {
            const title = titles.get(baseName(item.href));

            return { id: item.id, ...(title !== undefined && { title }) };
        });

    return {
        chapters,
        destroy: () => book.destroy(),
        read: async (id) => {
            const { css, html } = await book.loadChapter(id);
            const styles = await Promise.all(
                css.map(async (part) => {
                    try {
                        const response = await fetch(part.href);
                        const text = await response.text();

                        return await inlineBlobUrls(text);
                    } catch {
                        return "";
                    }
                }),
            );

            return chapterDocument(await inlineBlobUrls(html), styles);
        },
    };
};

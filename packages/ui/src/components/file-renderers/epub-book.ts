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
const READABLE_TYPES: ReadonlySet<string> = new Set(["application/xhtml+xml", "image/svg+xml", "text/html"]);

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

    let decoded = bare;

    try {
        // A name written with escapes (`my%20chapter.xhtml`) is the file stored under its plain name.
        decoded = decodeURIComponent(bare);
    } catch {
        // Kept as written.
    }

    // `..` and `.` segments are resolved, so a table of contents in a subfolder that names `../Text/c.xhtml` names `Text/c.xhtml`.
    const parts: string[] = [];

    for (const part of decoded.split("/")) {
        if (part === "..") {
            parts.pop();
        } else if (part !== "." && part !== "") {
            parts.push(part);
        }
    }

    return parts.join("/");
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

    // A title is set only by an entry whose path fits exactly one item. An entry that fits several sets none and takes none away: an item a
    // longer, unambiguous path already named keeps its title.
    const titles = new Map<string, string>();

    const visit = (points: EpubToc): void => {
        for (const point of points) {
            const fits = point.label === "" ? undefined : byTail.get(pathOf(point.href));

            if (fits?.size === 1) {
                const [id] = fits;

                if (id !== undefined && !titles.has(id)) {
                    titles.set(id, point.label);
                }
            }

            if (point.children !== undefined) {
                visit(point.children);
            }
        }
    };

    visit(toc);

    return titles;
};

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;

/**
 * Checks that the archive's central directory holds exactly the records its end record declares, and ends where the end record says. The
 * guard before this one (`assertOfficeZipWithinLimits`) walks only the declared count, but the zip library reads records until the signature
 * stops, so a directory with more records than declared would pass the guard and be opened in full. Throws on any mismatch; a well-formed
 * archive passes.
 */
export const assertZipDirectoryExact = (buffer: ArrayBuffer): void => {
    const view = new DataView(buffer);
    let end = buffer.byteLength - 22;

    // The LAST end record in the file, as the zip library takes it (it does not look at the comment length): one hidden in the real record's
    // comment, pointing at a directory nobody counted, is then the one examined, and its comment length does not reach the end of the file.
    while (end >= 0 && view.getUint32(end, true) !== EOCD_SIGNATURE) {
        end -= 1;
    }

    if (end < 0) {
        throw new Error("Not a ZIP archive");
    }

    if (view.getUint16(end + 20, true) !== buffer.byteLength - end - 22) {
        throw new Error("Corrupt ZIP directory");
    }

    const declared = view.getUint16(end + 10, true);
    const size = view.getUint32(end + 12, true);
    const start = view.getUint32(end + 16, true);
    let at = start;

    for (let index = 0; index < declared; index += 1) {
        if (at + 46 > buffer.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
            throw new Error("Corrupt ZIP directory");
        }

        at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }

    // No further record after the declared ones, and the directory is as long as the end record says.
    if ((at + 4 <= buffer.byteLength && view.getUint32(at, true) === CENTRAL_SIGNATURE) || at - start !== size) {
        throw new Error("Corrupt ZIP directory");
    }
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

/** The reader's budget, count and cache as they stood, so a sheet that is not kept gives back everything it took, what it cached included. */
interface StagedBudget {
    attributed: number;
    files: number;
    left: number;
    pictureCharged: number;
    seen: ReadonlyMap<string, { cost: number; url: string } | undefined>;
}

/** What a chapter's reads draw on: one budget for its styles and its markup, a count of distinct files, and a reader of the archive. */
interface AssetReader {
    /** Throws when the read was abandoned: asked after each completed read, before any more is parsed or built. */
    check: () => void;
    /** A file as a `data:` URL, or `undefined` when it is not in the archive, does not fit the budget or the count, or is not a kind that is inlined. */
    dataUrl: (path: string) => Promise<string | undefined>;
    /** Whether `length` characters could still be spent (without spending them). */
    fits: (length: number) => boolean;
    /** Whether the chapter may still take another file at all (some budget and some count left): asked before a file is read. */
    mayRead: () => boolean;
    /** Whether a style sheet has been refused for size or count: the chapter then reads no further sheet. */
    refused: () => boolean;
    restore: (state: StagedBudget) => void;
    /** The size of a file as the archive's directory declares it, when it does; read before the file is, so one too big is never opened. */
    size: (path: string) => number | undefined;
    /** The budget and count as they stand: taken before a sheet is rewritten, given back with `restore` if the sheet is not kept. */
    snapshot: () => StagedBudget;
    /** Charges a style sheet that is to go into the document, after its addresses are rewritten, to the budget and the count; `false` when it does not fit. A sheet whose `data:` pictures were already charged when they were read: only the rest of its text is charged now. */
    spendSheet: (length: number) => boolean;
    /** Takes one file from the chapter's count (an `@import` is a file); `false` when none is left. */
    takeFile: () => boolean;
    /** A text file of the archive. */
    text: (path: string) => Promise<string | undefined>;
}

const assetReader = (zip: JSZip, declared: ReadonlyMap<string, string>, signal?: AbortSignal): AssetReader => {
    const budget = { files: MAX_ASSETS_PER_CHAPTER, left: MAX_INLINED_CHARS };
    let refusedSheet = false;
    // The cost of pictures already counted against a sheet: they are charged once, when read, not again as part of the sheet.
    let pictureCharged = 0;
    let attributed = 0;
    // What each file became, and what it costs each time it is written into the document.
    const seen = new Map<string, { cost: number; url: string } | undefined>();
    // What a file turned out to cost when it did not fit: remembered, so a later reference does not inflate it again.
    const tooBig = new Map<string, number>();

    return {
        check: () => signal?.throwIfAborted(),
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

            // The type the book's manifest declares for a picture or font, else the one its extension says (a file with no extension is still a picture).
            const declaredType = declared.get(path);
            const type = declaredType?.startsWith("image/") || declaredType?.startsWith("font/") ? declaredType : MEDIA_TYPES[extensionOf(path)];
            const entry = type === undefined ? null : zip.file(path);

            // Not there, or not a kind that is inlined: that stays so, and is remembered. A refusal for the budget or the count is not a fact
            // about the file, so it is not remembered: a sheet that is given back leaves the file to be tried again.
            if (entry === null || type === undefined) {
                seen.set(path, undefined);

                return undefined;
            }

            if (budget.files <= 0 || budget.left <= 0) {
                return undefined;
            }

            // Judged from the size the archive declares BEFORE it is inflated, and from what an earlier try found, so a file that cannot fit is
            // not inflated again for each reference to it.
            const declaredSize = (entry as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
            const estimate = declaredSize === undefined ? 0 : `data:${type};base64,`.length + Math.ceil(declaredSize / 3) * 4;

            if (estimate > budget.left || (tooBig.get(path) ?? 0) > budget.left) {
                return undefined;
            }

            budget.files -= 1;

            const bytes = await entry.async("uint8array");

            signal?.throwIfAborted();
            // From the size, before the encoding: one that will not fit is never encoded.
            const length = `data:${type};base64,`.length + Math.ceil(bytes.length / 3) * 4;

            if (length > budget.left) {
                tooBig.set(path, length);

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
        restore: (state) => {
            budget.files = state.files;
            budget.left = state.left;
            pictureCharged = state.pictureCharged;
            attributed = state.attributed;
            seen.clear();

            for (const [path, entry] of state.seen) {
                seen.set(path, entry);
            }
        },
        size: (path) => (zip.file(path) as { _data?: { uncompressedSize?: number } } | null)?._data?.uncompressedSize,
        snapshot: () => {
            return { attributed, files: budget.files, left: budget.left, pictureCharged, seen: new Map(seen) };
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
        takeFile: () => {
            if (budget.files <= 0) {
                return false;
            }

            budget.files -= 1;

            return true;
        },
        text: async (path) => {
            signal?.throwIfAborted();

            const read = (await zip.file(path)?.async("string")) ?? undefined;

            signal?.throwIfAborted();

            return read;
        },
    };
};

// A quoted address reads an escaped character inside it (`\"`), so a quote or a parenthesis in a file name does not end it early.
const CSS_URL = /url\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\)/gisu;
const CSS_HEX_ESCAPE = /\\([\da-f]{1,6})\s?/giu;
const CSS_ESCAPED = /\\([\s\S])/gu;
const CSS_QUOTE = /^["']|["']$/gu;
const CSS_SCRIPTY = /expression\s*\(|-moz-binding\s*:|behaviou?r\s*:/giu;
const LESS_THAN = /</gu;
const CSS_ESCAPE = /\\([\da-f]{1,6})\s?/giu;
const IMAGE_SET = /(?:-webkit-)?image-set\s*\((?:[^()]|\([^()]*\))*\)/giu;
const SRC_FUNCTION = /(?<![\w-])src\s*\((?:[^()]|\([^()]*\))*\)/giu;

/** The address a `url()` argument names: trimmed, unquoted, and with each backslash escape read as the character it escapes. */
const addressOf = (argument: string): string =>
    argument
        .trim()
        .replaceAll(CSS_QUOTE, "")
        .replaceAll(CSS_HEX_ESCAPE, (_match, hex: string) => {
            const code = Number.parseInt(hex, 16);

            // A value that is not a character (zero, a surrogate, past the last code point) is the replacement character, as CSS says.
            return code === 0 || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff) ? "\u{FFFD}" : String.fromCodePoint(code);
        })
        .replaceAll(CSS_ESCAPED, "$1")
        .trim();

const isDataUrl = (address: string): boolean => addressOf(address).toLowerCase().startsWith("data:");

const dataOnly = (match: string, argument: string): string => (isDataUrl(argument) ? match : 'url("")');

/**
 * A book's style sheet as text for a `<style>` element: no `@import`, no `url()` that is not a `data:` one (it is made empty), no
 * `expression(`, `behavior:` or `-moz-binding:` (old engines ran script from them), and every `<` as the CSS escape `\3c `, so nothing in it
 * can end the element or begin markup. An ordinary sheet is otherwise as it was.
 */
export const safeStylesheet = (css: string): string => {
    // An escaped letter is that letter to a CSS parser (`\75 rl(` is `url(`): they are written out first, so the patterns below see what it sees.
    // Escapes that are not letters (a `\3c ` this function wrote, `\:` in a selector) are left as they are.
    const plain = css.replaceAll(CSS_ESCAPE, (match, hex: string) => {
        const code = Number.parseInt(hex, 16);

        // Only an ASCII value is looked at: a larger one (`\FFFFFF`) is not a code point, and `fromCodePoint` of it would throw.
        if (code === 0 || code >= 128) {
            return match;
        }

        const letter = String.fromCodePoint(code);

        return ASCII_LETTER.test(letter) ? letter : match;
    });
    const withoutImports = withoutImportRules(plain);
    const dataUrlsOnly = withoutImports.replaceAll(CSS_URL, (match, argument: string) => dataOnly(match, argument));

    return dataUrlsOnly
        .replaceAll(CSS_SCRIPTY, "blocked:")
        .replaceAll(IMAGE_SET, "none")
        .replaceAll(SRC_FUNCTION, "none")
        .replaceAll(LESS_THAN, String.raw`\3c `);
};

/** A style sheet's relative `url()`s replaced by the files they name, within the chapter's budget; the rest are left for `safeStylesheet` to empty. */
const inlineStylesheetUrls = async (css: string, directory: string, reader: AssetReader): Promise<string> => {
    // One answer per OCCURRENCE, in order: a file named many times is written many times, so it is charged each time (`dataUrl` charges a copy
    // it already has as it does the first), and once the budget is spent the rest of the occurrences are left as they were.
    const found = [...css.matchAll(CSS_URL)].map((match) => match[1] ?? "");
    const answers: (string | undefined)[] = [];

    for (const argument of found) {
        const path = resolveInArchive(addressOf(argument), directory);

        answers.push(path === undefined ? undefined : await reader.dataUrl(path));
    }

    let at = 0;

    return css.replaceAll(CSS_URL, (match) => {
        const url = answers[at];

        at += 1;

        return url === undefined ? match : `url("${url}")`;
    });
};

const ASCII_LETTER = /[a-z]/iu;
const IMPORT_AT = /@import(?![\w-])/giu;
const SPACE = /\s/u;

/** Whether the `@import` at `index` of `code` starts a statement: it is the first thing in the sheet, or follows a `;`, `{` or `}`. One inside a value is text. */
const startsStatement = (code: string, index: number): boolean => {
    let at = index - 1;

    while (at >= 0 && SPACE.test(code[at] ?? "")) {
        at -= 1;
    }

    return at < 0 || ";{}".includes(code[at] ?? "");
};
const IMPORT_END = /[;{]/u;
const IMPORT_HEAD = /@import\s+(?:url\(\s*)?/iuy;
const IMPORT_TARGET = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s;)]*)/suy;
const IMPORT_TAIL = /([^;{]*);?/uy;

/** The import rule that starts at `index` of `css`: the whole text of it, its path (one of the first three groups) and its media list (the fourth). */
const matchImport = (css: string, index: number): { 0: string; 1?: string; 2?: string; 3?: string; 4?: string } | null => {
    IMPORT_HEAD.lastIndex = index;

    const head = IMPORT_HEAD.exec(css);

    if (head === null) {
        return null;
    }

    IMPORT_TARGET.lastIndex = index + head[0].length;

    const target = IMPORT_TARGET.exec(css);

    if (target === null) {
        return null;
    }

    IMPORT_TAIL.lastIndex = IMPORT_TARGET.lastIndex;

    const tail = IMPORT_TAIL.exec(css);

    return { 0: `${head[0]}${target[0]}${tail?.[0] ?? ""}`, 1: target[1], 2: target[2], 3: target[3], 4: tail?.[1] ?? "" };
};
const PATH_ESCAPE = /\\([\s\S])/gu;

/**
 * The CSS with each comment (outside any string) written as one space, so the words either side stay apart, and a second copy of the same
 * length in which the inside of every quoted string is blanked. `@import` is looked for in the second, so one inside `content: "@import 'x';"`
 * is text, not a rule; the rule itself is read from the first, so a path like `"a/*b*\/.css"` is read whole, comment marks inside it included.
 */
const scanCss = (css: string): { code: string; text: string } => {
    let text = "";
    let code = "";
    let quote = "";
    let at = 0;

    while (at < css.length) {
        const char = css[at] ?? "";
        let step = 1;

        if (quote !== "") {
            if (char === "\\" && at + 1 < css.length) {
                text += `${char}${css[at + 1] ?? ""}`;
                code += "\u{1}\u{1}";
                step = 2;
            } else {
                text += char;
                code += char === quote ? char : "\u{1}";
                quote = char === quote ? "" : quote;
            }
        } else if (char === "/" && css[at + 1] === "*") {
            const end = css.indexOf("*/", at + 2);

            text += " ";
            code += " ";
            step = (end === -1 ? css.length : end + 2) - at;
        } else if (char === "\\" && at + 1 < css.length) {
            // Outside a string a backslash escapes the next character too (`\"` in an identifier is not the start of a string).
            text += `${char}${css[at + 1] ?? ""}`;
            code += `${char}${css[at + 1] ?? ""}`;
            step = 2;
        } else {
            quote = char === '"' || char === "'" ? char : "";
            text += char;
            code += char;
        }

        at += step;
    }

    return { code, text };
};
const CLOSING_PAREN = /^\s*\)/u;
/** A media list that can be carried into an `@media` rule as it is: words, numbers, commas, parentheses, colons, comparison signs and spaces, nothing that opens or ends a rule or names a function. */
const SAFE_MEDIA = /^[\w\s,():.<>=/-]+$/u;
const MEDIA_ALL = /^all$/iu;
const UNSUPPORTED_CONDITION = /supports|layer|url|image-set/iu;
const MAX_IMPORT_DEPTH = 4;

/**
 * A sheet's text with each `@import` that names a file of the archive replaced, at its position, by that file's text, itself expanded and with
 * its own addresses read from its own folder. An import that does not resolve to a file of the archive, is already being read further up (a
 * cycle), is too deep, or does not fit the chapter's count and budget is dropped. What this returns is raw text: the caller cleans and charges it.
 */
const expandImports = async (
    source: string,
    directory: string,
    reader: AssetReader,
    stack: ReadonlyArray<string>,
    shared?: { length: number },
): Promise<string> => {
    const produced = shared ?? { length: 0 };
    // A comment is not a rule, and neither is text inside a string: an `@import` in either is inert and must not take a file of the count.
    const { code, text: css } = scanCss(source);
    const rules: { 0: string; 1?: string; 2?: string; 3?: string; 4?: string; index: number }[] = [];
    let resume = 0;

    for (const found of code.matchAll(IMPORT_AT)) {
        if (found.index < resume || !startsStatement(code, found.index)) {
            continue;
        }

        const rule = matchImport(css, found.index);

        if (rule !== null) {
            rules.push({ ...rule, index: found.index });
            resume = found.index + rule[0].length;
        }
    }

    let out = "";
    let at = 0;

    for (const rule of rules) {
        out += css.slice(at, rule.index);
        at = rule.index + rule[0].length;

        // The import's media list is kept: print-only or narrow-screen styles must not apply to every screen. `all` and an empty list are no
        // condition; a list that cannot be carried over safely drops the import, as one that cannot be resolved is.
        const media = (rule[4] ?? "").replace(CLOSING_PAREN, "").trim();
        const conditioned = media !== "" && !MEDIA_ALL.test(media);

        if (conditioned && (!SAFE_MEDIA.test(media) || UNSUPPORTED_CONDITION.test(media))) {
            continue;
        }

        const path = resolveInArchive((rule[1] ?? rule[2] ?? rule[3] ?? "").replaceAll(PATH_ESCAPE, "$1").trim(), directory);
        const declared = path === undefined ? undefined : reader.size(path);

        if (
            path === undefined ||
            stack.includes(path) ||
            stack.length >= MAX_IMPORT_DEPTH ||
            (declared !== undefined && !reader.fits(produced.length + declared)) ||
            !reader.takeFile()
        ) {
            continue;
        }

        const text = await reader.text(path);

        // What this expansion has produced so far counts too: the same sheet imported over and over cannot add up to more than the chapter may take.
        if (text === undefined || !reader.fits(produced.length + text.length + 3 * countLessThan(text))) {
            continue;
        }

        const expanded = await expandImports(text, directoryOf(path), reader, [...stack, path], produced);

        const inlined = await inlineStylesheetUrls(expanded, directoryOf(path), reader);

        const piece = conditioned ? `@media ${media} { ${inlined} }` : inlined;

        produced.length += piece.length;
        out += piece;
    }

    return out + css.slice(at);
};

/**
 * What the frame may load: nothing by itself, only styles written in the document and pictures or fonts carried in it. Scripts, frames,
 * forms, connections and every other address are refused. The frame's `sandbox` is the first wall and this the second, for a request
 * a chapter's markup could still make without a script (a picture or style sheet from another site).
 */
export const FRAME_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,12}$/u;
const MAX_LANGUAGE_LENGTH = 64;
/** A well-formed language tag (letters, digits and hyphens, subtags of one to eight characters), of a length that is capped. */
const isLanguageTag = (value: string): boolean => value.length <= MAX_LANGUAGE_LENGTH && LANGUAGE_TAG.test(value);

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

/** One class name: a CSS identifier, non-ASCII letters included (`chapitre-é`). */
const CLASS_TOKEN = /^-?[\p{L}_][\p{L}\p{N}_-]*$/u;
const MAX_CLASS_LENGTH = 400;
const WHITESPACE = /\s+/u;

const safeClassNames = (value: string): string =>
    value
        .trim()
        .split(WHITESPACE)
        .filter((token) => CLASS_TOKEN.test(token))
        .join(" ")
        .slice(0, MAX_CLASS_LENGTH);
const DIRECTIONS: ReadonlySet<string> = new Set(["auto", "ltr", "rtl"]);

const safeBodyAttributes = (attributes: Readonly<Record<string, string>>): Record<string, string> => {
    const kept: Record<string, string> = {};
    const { class: classNames, dir, lang } = attributes;

    const classes = classNames === undefined ? "" : safeClassNames(classNames);

    if (classes !== "") {
        kept.class = classes;
    }

    if (dir !== undefined && DIRECTIONS.has(dir.trim().toLowerCase())) {
        kept.dir = dir.trim().toLowerCase();
    }

    if (lang !== undefined && isLanguageTag(lang.trim())) {
        kept.lang = lang.trim();
    }

    return kept;
};

/** The CSS without its `@import` rules, which are read where the code is, not inside a string; a comment is one space (see `scanCss`). */
const withoutImportRules = (css: string): string => {
    const { code, text } = scanCss(css);
    let out = "";
    let at = 0;

    for (const found of code.matchAll(IMPORT_AT)) {
        if (found.index < at || !startsStatement(code, found.index)) {
            continue;
        }

        const end = text.slice(found.index).search(IMPORT_END);

        out += text.slice(at, found.index);
        // The `;` ends the rule and goes with it; a `{` is not part of it.
        const closer = text[found.index + end] === ";" ? 1 : 0;

        at = end === -1 ? text.length : found.index + end + closer;
    }

    return out + text.slice(at);
};

/**
 * A chapter's markup as a whole document. The policy is the first element of the head, written before any of the chapter is; the markup is
 * then parsed by the browser's own parser in a document of its own that loads and runs nothing, neutralized (`neutralize`), and only then moved
 * into the document. The book's styles follow the policy as inert text (`safeStylesheet`).
 */
export const chapterDocument = (
    markup: string,
    styles: ReadonlyArray<string>,
    language?: string,
    bodyAttributes: Readonly<Record<string, string>> = {},
): string => {
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
        // `about:srcdoc`: a `#` link resolves against the document itself, not the page that holds the frame.
        make("base", { href: "about:srcdoc", target: "_blank" }),
        make("style", {}, BASE_STYLE),
        ...styles.map((style) => make("style", {}, safeStylesheet(style))),
    ];

    for (const node of head) {
        // `appendChild`: `append` is typed for a worker's HTML rewriter in the projects that type this file with the Workers library.

        frame.head.appendChild(node);
    }

    if (language !== undefined && isLanguageTag(language)) {
        frame.documentElement.setAttribute("lang", language);
    }

    const chapter = new DOMParser().parseFromString(`<!doctype html><html><body>${markup}</body></html>`, "text/html");

    neutralize(chapter.body);

    // The chapter body's `class`, `dir` and `lang` (the rules of a book often select on them), filtered first: a class is names only, `dir` one
    // of its three values, `lang` a language tag. Nothing else of the body element is carried.
    const carried = Object.entries(safeBodyAttributes(bodyAttributes));

    for (const [name, value] of carried) {
        frame.body.setAttribute(name, value);
    }

    const nodes = [...chapter.body.childNodes];

    for (const node of nodes) {
        frame.body.appendChild(frame.importNode(node, true));
    }

    return settle(`<!doctype html>${frame.documentElement.outerHTML}`);
};

/**
 * The document as a browser will read it back. The frame parses this string again, and markup whose serialization parses differently the
 * second time (nested forms, foreign content in raw text) could carry something past the cleaning done on the first parse. So the string is
 * parsed as the frame will parse it, cleaned again, and serialized, until it no longer changes; a chapter that will not settle in a few rounds
 * is refused.
 */
const settle = (serialized: string): string => {
    let current = serialized;

    for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
        const again = new DOMParser().parseFromString(current, "text/html");

        neutralize(again.body);

        const next = `<!doctype html>${again.documentElement.outerHTML}`;

        if (next === current) {
            return current;
        }

        current = next;
    }

    throw new Error("chapter could not be made safe");
};
const MAX_SETTLE_ROUNDS = 4;

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
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

/**
 * A node of an XHTML chapter in the HTML document it is moved to. An SVG or MathML element written with a prefix (`<svg:svg>`) becomes the
 * same element without one, so serializing it as HTML and reading it again gives artwork, not an unknown element named `svg:svg`. Attributes
 * keep their names (`xlink:href`).
 */
const cloneIntoHtml = (node: Node, html: Document): Node => {
    if (node.nodeType !== 1) {
        return html.importNode(node, true);
    }

    const element = node as Element;
    const space = element.namespaceURI;
    const made =
        space === SVG_NAMESPACE || space === MATHML_NAMESPACE ? html.createElementNS(space, element.localName) : (html.importNode(element, false) as Element);

    if (made !== (element as Node)) {
        for (const attribute of element.attributes) {
            if (!made.hasAttribute(attribute.name)) {
                made.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
            }
        }
    }

    for (const child of element.childNodes) {
        made.appendChild(cloneIntoHtml(child, html));
    }

    return made;
};

const parseChapter = (source: string): Document => {
    const html = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
    const xml = new DOMParser().parseFromString(source, "application/xhtml+xml");

    if (xml.querySelector("parsererror") !== null || xml.documentElement.localName !== "html" || xml.querySelector("body") === null) {
        return new DOMParser().parseFromString(source, "text/html");
    }

    // The body's own attributes: the ones carried on are filtered later (`safeBodyAttributes`).
    for (const name of ["class", "dir", "lang"]) {
        const value = xml.querySelector("body")?.getAttribute(name);

        if (value !== null && value !== undefined) {
            html.body.setAttribute(name, value);
        }
    }

    for (const [from, to] of [
        [xml.querySelector("head"), html.head],
        [xml.querySelector("body"), html.body],
    ] as const) {
        const children = [...(from?.childNodes ?? [])];

        for (const node of children) {
            to.appendChild(cloneIntoHtml(node, html));
        }
    }

    return html;
};

const readChapter = async (chapterPath: string, reader: AssetReader): Promise<{ body: Record<string, string>; markup: string; styles: string[] }> => {
    // Refused from the archive's declared size before it is inflated: a chapter over the cap is never read into a string.
    if ((reader.size(chapterPath) ?? 0) > MAX_CHAPTER_CHARS) {
        throw new Error("chapter too large");
    }

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

    // Linked and inline styles in the order the chapter writes them, each rewritten and charged as it is reached: a later rule wins over an
    // earlier one as in the source. Sheets of the head go to `styles` in that order; a `<style>` in the body stays where it is.
    for (const item of parsed.querySelectorAll('link[rel~="stylesheet" i][href]:not([rel~="alternate" i]), style')) {
        const isLink = item.localName === "link";
        const inHead = item.closest("head") !== null;

        // After a sheet was refused for size or count, no further one is attempted: the rejection work is not repeated for each.
        if (reader.refused() || !reader.mayRead()) {
            if (!isLink) {
                item.textContent = "";
            }

            continue;
        }

        let text: string | undefined = item.textContent ?? "";
        let base = directory;
        let self: string[] = [];

        if (isLink) {
            const path = resolveInArchive(item.getAttribute("href") ?? "", directory);
            const declared = path === undefined ? undefined : reader.size(path);

            // A sheet whose declared size cannot fit is refused whole before it is read or rewritten: the rewrite can only make it longer.
            if (declared !== undefined && !reader.fits(declared)) {
                reader.spendSheet(Infinity);

                continue;
            }

            text = path === undefined ? undefined : await reader.text(path);
            base = path === undefined ? directory : directoryOf(path);
            // The sheet itself is the first of the files being read: an import that leads back to it is a cycle.
            self = path === undefined ? [] : [path];
        }

        reader.check();

        if (text === undefined) {
            continue;
        }

        // What cleaning can make of it, worked out before anything is rewritten: every `<` becomes four characters.
        if (!reader.fits(text.length + 3 * countLessThan(text))) {
            reader.spendSheet(Infinity);

            if (!isLink) {
                item.textContent = "";
            }

            continue;
        }

        // What the pictures and imports of this sheet take is staged: kept only if the sheet is, so a rejected sheet leaves the room it used.
        const staged = reader.snapshot();
        // Imports first, then addresses, then cleaned; the exact text that will be written is what is charged.
        // The outer sheet's own text is reserved with what its imports add, so the combined text is bounded before any of it is built.
        const expanded = await expandImports(text, base, reader, self, { length: text.length + 3 * countLessThan(text) });
        const sheet = safeStylesheet(await inlineStylesheetUrls(expanded, base, reader));

        reader.check();

        // A sheet that does not fit is left out whole, not cut: half a sheet would style a chapter wrongly.
        const fits = reader.spendSheet(sheet.length);

        if (!fits) {
            reader.restore(staged);
        }

        const kept = fits ? sheet : "";

        if (isLink || inHead) {
            if (kept !== "") {
                styles.push(kept);
            }
        } else {
            item.textContent = kept;
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
    // The candidates of a `<picture>`: each `source` keeps its `media` and `type`, and its first candidate becomes the one data address.
    for (const candidate of parsed.body.querySelectorAll("source[srcset]")) {
        const first = candidate.getAttribute("srcset")?.trim().split(SPLIT_CANDIDATE, 1)[0];
        const path = first === undefined ? undefined : resolveInArchive(first, directory);
        const url = path === undefined ? undefined : await reader.dataUrl(path);

        if (url !== undefined) {
            candidate.setAttribute("srcset", url);
        }
    }

    for (const element of parsed.body.querySelectorAll("[style], img[srcset]:not([src])")) {
        const style = element.getAttribute("style");

        if (style !== null && style.includes("url(")) {
            element.setAttribute("style", await inlineStylesheetUrls(style, directory, reader));
        }

        const first = element.localName === "img" ? element.getAttribute("srcset")?.trim().split(SPLIT_CANDIDATE, 1)[0] : undefined;
        const path = first === undefined ? undefined : resolveInArchive(first, directory);
        const url = path === undefined ? undefined : await reader.dataUrl(path);

        if (url !== undefined) {
            element.setAttribute("src", url);
        }
    }

    const body = Object.fromEntries(
        ["class", "dir", "lang"].flatMap((name) => (parsed.body.hasAttribute(name) ? [[name, parsed.body.getAttribute(name) ?? ""] as const] : [])),
    );

    // eslint-disable-next-line unicorn/prefer-dom-node-html-methods -- `getHTML` is not in every engine this runs in (nor in jsdom)
    return { body, markup: parsed.body.innerHTML, styles };
};

/** Books opened so far: each gets a folder of its own for the parser, so two books never write over each other. */
const opened = { count: 0 };

export const openEpub = async (bytes: Uint8Array, resourceSaveDirectory?: string): Promise<OpenedEpub> => {
    const [{ initEpubFile }, zip] = await Promise.all([import("@lingo-reader/epub-parser"), JSZip.loadAsync(bytes)]);
    // The parser reads the structure only; it is given a folder of its own (its default is shared by every book on the page).
    const book = await initEpubFile(bytes, resourceSaveDirectory ?? `./epub-${String(++opened.count)}`);
    const spine = book.getSpine().filter((item) => READABLE_TYPES.has(item.mediaType));
    const titles = titlesBySpineItem(book.getToc(), spine);
    // Declared by the manifest, by path: `getManifest` lists each file once, whether or not the spine names it.
    const mediaTypes = new Map(Object.values(book.getManifest()).map((item) => [pathOf(item.href), item.mediaType] as const));
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

            const reader = assetReader(zip, mediaTypes, signal);
            const { body, markup, styles } = await readChapter(chapterPath, reader);

            return chapterDocument(markup, styles, language, body);
        },
    };
};

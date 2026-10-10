/**
 * Turning a knowledge source into text: an uploaded or stored document, or a
 * web page by URL. The network and the parser are injected, so every path is
 * tested without either (`sources.test.ts`); `ingest.ts` wires the real ones.
 *
 * URL fetches go through the SSRF guard (`isSafeUrl`, the tools'
 * `fetchWithTimeout`) and follow redirects by hand, re-checking every hop — a
 * public URL that redirects to `169.254.169.254` is refused at the hop, not
 * fetched. When the Browser Rendering worker is configured it renders the page
 * first (JavaScript-built pages have no text in their HTML); it validates the
 * URL on its own side as well.
 */
import { LunoraError } from "lunorash/server";

/** Largest body read from a URL. Pages are far smaller; a PDF link may not be. */
export const MAX_URL_BYTES = 10 * 1024 * 1024;
export const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;

/** MIME types read directly as UTF-8 text. */
const TEXT_MIME_TYPES = new Set([
    "application/json",
    "application/xml",
    "application/yaml",
    "text/csv",
    "text/javascript",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
    "text/x-c",
    "text/x-java",
    "text/x-python",
    "text/x-typescript",
    "text/xml",
    "text/yaml",
]);

const HTML_MIME_TYPES = new Set(["application/xhtml+xml", "text/html"]);

export const baseMimeType = (mimeType: string): string => mimeType.split(";", 1)[0]!.trim().toLowerCase();

export const isHtmlMimeType = (mimeType: string): boolean => HTML_MIME_TYPES.has(baseMimeType(mimeType));

/** Text that is not HTML: read as is. */
export const isPlainTextMimeType = (mimeType: string): boolean => {
    const base = baseMimeType(mimeType);

    return !isHtmlMimeType(base) && (TEXT_MIME_TYPES.has(base) || base.startsWith("text/"));
};

// ─── HTML ────────────────────────────────────────────────────────────────────

const DROP_ELEMENTS_RE = /<(script|style|noscript|svg|head|template|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const BREAK_RE = /<br\s*\/?>/gi;
const BLOCK_END_RE = /<\/(p|div|section|article|header|footer|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dt|dd)\s*>/gi;
const HEADING_START_RE = /<h([1-6])\b[^>]*>/gi;
const LIST_ITEM_START_RE = /<li\b[^>]*>/gi;
const CELL_END_RE = /<\/t[dh]\s*>/gi;
const TITLE_OPEN_RE = /<title\b[^>]*>/i;
const NUMERIC_ENTITY_RE = /&#(\d+);/g;
const HEX_ENTITY_RE = /&#x([\da-f]+);/gi;
const NAMED_ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#39);/g;
const INLINE_SPACE_RE = /[ \t\f\v\u{A0}]+/gu;
const MANY_NEWLINES_RE = /\n{3,}/g;

const NAMED_ENTITIES: Record<string, string> = { "#39": "'", amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };

const decodeEntities = (text: string): string =>
    text
        .replaceAll(NUMERIC_ENTITY_RE, (_, code: string) => String.fromCodePoint(Number(code)))
        .replaceAll(HEX_ENTITY_RE, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replaceAll(NAMED_ENTITY_RE, (_, name: string) => NAMED_ENTITIES[name] ?? "");

/** Removes every remaining `<…>` tag; a `<` with no closing `>` is kept as text. */
const stripTags = (html: string): string => {
    let result = "";
    let index = 0;

    while (index < html.length) {
        const open = html.indexOf("<", index);
        const close = open === -1 ? -1 : html.indexOf(">", open + 1);

        if (close === -1) {
            result += html.slice(index);
            break;
        }

        if (close === open + 1) {
            // `<>` is text, not a tag.
            result += html.slice(index, close + 1);
            index = close + 1;
            continue;
        }

        result += html.slice(index, open);
        index = close + 1;
    }

    return result;
};

/**
 * HTML → readable text with its paragraph structure, for when no parser is
 * configured. Blank lines between blocks matter: the chunker splits on them.
 */
export const htmlToText = (html: string): string => {
    const text = html
        .replaceAll(COMMENT_RE, "")
        .replaceAll(DROP_ELEMENTS_RE, "")
        .replaceAll(HEADING_START_RE, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
        .replaceAll(LIST_ITEM_START_RE, "\n- ")
        .replaceAll(BREAK_RE, "\n")
        .replaceAll(CELL_END_RE, " | ")
        .replaceAll(BLOCK_END_RE, "\n\n");

    return decodeEntities(stripTags(text))
        .split("\n")
        .map((line) => line.replaceAll(INLINE_SPACE_RE, " ").trim())
        .join("\n")
        .replaceAll(MANY_NEWLINES_RE, "\n\n")
        .trim();
};

export const htmlTitle = (html: string): string | undefined => {
    const open = TITLE_OPEN_RE.exec(html);
    const start = open ? open.index + open[0].length : -1;
    const end = start === -1 ? -1 : html.toLowerCase().indexOf("</title>", start);
    const title = end === -1 ? undefined : html.slice(start, end);

    return title ? decodeEntities(title).replaceAll(INLINE_SPACE_RE, " ").trim() || undefined : undefined;
};

// ─── Documents ───────────────────────────────────────────────────────────────

/** Extracts text from a binary document (the document-parser Worker); absent when it is not configured. */
export type ParseDocument = (bytes: ArrayBuffer, mimeType: string) => Promise<string>;

/**
 * A document's text: plain text as is, HTML through the parser when there is
 * one (it keeps tables and structure) or {@link htmlToText}, anything else
 * through the parser.
 */
export const documentToText = async (bytes: ArrayBuffer, mimeType: string, parse: ParseDocument | undefined): Promise<string> => {
    if (isPlainTextMimeType(mimeType)) {
        return new TextDecoder().decode(bytes);
    }

    if (isHtmlMimeType(mimeType)) {
        if (parse) {
            try {
                return await parse(bytes, "text/html");
            } catch {
                // The fallback below is always available for HTML.
            }
        }

        return htmlToText(new TextDecoder().decode(bytes));
    }

    if (!parse) {
        throw new LunoraError("UNPROCESSABLE", `Cannot read ${baseMimeType(mimeType)} files: the document parser is not configured`);
    }

    return await parse(bytes, baseMimeType(mimeType));
};

// ─── URLs ────────────────────────────────────────────────────────────────────

export interface UrlFetchDependencies {
    /** Deadline for reading the BODY once headers arrived; defaults to {@link URL_BODY_READ_TIMEOUT_MS}. */
    bodyTimeoutMs?: number;
    /** The SSRF-guarded fetch (`fetchWithTimeout`): refuses unsafe URLs, never follows redirects itself. */
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    isSafeUrl: (url: string) => boolean;
    parse?: ParseDocument;
    /** Browser Rendering: the page's text after JavaScript ran. Absent when the worker is not configured. */
    render?: (url: string) => Promise<{ content: string; title?: string }>;
}

/**
 * How long a page's body may take to arrive. `fetchWithTimeout`'s deadline ends
 * at the headers, so without this a server sending 1 byte/s up to the size cap
 * held the ingest action until the platform's 15-minute limit — and a user
 * adding URLs could fill their scheduler lanes with such reads.
 */
export const URL_BODY_READ_TIMEOUT_MS = 60_000;

export interface FetchedDocument {
    mimeType: string;
    text: string;
    title?: string;
    /** Where the content came from after redirects. */
    url: string;
}

/** A URL a user may add: public http(s), not too long. Throws BAD_REQUEST otherwise. */
export const normalizeIngestUrl = (raw: string, isSafeUrl: (url: string) => boolean): string => {
    const trimmed = raw.trim();
    let parsed: URL;

    try {
        parsed = new URL(trimmed);
    } catch {
        throw new LunoraError("BAD_REQUEST", "Not a valid URL");
    }

    parsed.hash = "";

    const url = parsed.href;

    if (url.length > MAX_URL_LENGTH || !isSafeUrl(url)) {
        throw new LunoraError("BAD_REQUEST", "Only public http(s) URLs can be added");
    }

    return url;
};

/**
 * The body, refusing (and cancelling) anything over {@link MAX_URL_BYTES} or
 * slower than `timeoutMs` in total.
 */
const readCapped = async (response: Response, timeoutMs: number): Promise<ArrayBuffer> => {
    const declared = Number(response.headers.get("content-length") ?? "0");

    if (declared > MAX_URL_BYTES) {
        await response.body?.cancel();

        throw new LunoraError("PAYLOAD_TOO_LARGE", `The page is larger than ${String(MAX_URL_BYTES / 1024 / 1024)} MB`);
    }

    if (!response.body) {
        return await response.arrayBuffer();
    }

    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(resolve, timeoutMs, "timeout");
    });

    try {
        for (;;) {
            const chunk = await Promise.race([reader.read(), deadline]);

            if (chunk === "timeout") {
                // Not awaited: a stalled source may never settle the cancel either.
                reader.cancel().catch(() => undefined);

                throw new LunoraError("UNPROCESSABLE", `The page took longer than ${String(timeoutMs / 1000)}s to download`);
            }

            if (chunk.done) {
                break;
            }

            total += chunk.value.byteLength;

            if (total > MAX_URL_BYTES) {
                await reader.cancel();

                throw new LunoraError("PAYLOAD_TOO_LARGE", `The page is larger than ${String(MAX_URL_BYTES / 1024 / 1024)} MB`);
            }

            parts.push(chunk.value);
        }
    } finally {
        clearTimeout(timer);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }

    return bytes.buffer;
};

/** GET with redirects followed by hand, every hop re-checked. */
const fetchFollowingRedirects = async (url: string, dependencies: UrlFetchDependencies): Promise<{ response: Response; url: string }> => {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (!dependencies.isSafeUrl(current)) {
            throw new LunoraError("BAD_REQUEST", "The URL redirects to an address that cannot be fetched");
        }

        const response = await dependencies.fetch(current, {
            headers: {
                Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf;q=0.9,*/*;q=0.5",
                "User-Agent": "Mozilla/5.0 (compatible; NeoreBot/1.0; +knowledge-import)",
            },
            method: "GET",
            redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");

            await response.body?.cancel();

            if (!location) {
                throw new LunoraError("UNPROCESSABLE", `Redirect (${String(response.status)}) without a location`);
            }

            current = new URL(location, current).href;
            continue;
        }

        return { response, url: current };
    }

    throw new LunoraError("UNPROCESSABLE", "Too many redirects");
};

/**
 * A web page (or a document behind a URL) as text. The renderer goes first
 * when there is one; its failure falls back to a plain fetch.
 */
export const fetchUrlDocument = async (url: string, dependencies: UrlFetchDependencies): Promise<FetchedDocument> => {
    if (!dependencies.isSafeUrl(url)) {
        throw new LunoraError("BAD_REQUEST", "Only public http(s) URLs can be added");
    }

    if (dependencies.render) {
        try {
            const rendered = await dependencies.render(url);

            if (rendered.content.trim()) {
                return { mimeType: "text/html", text: rendered.content.trim(), title: rendered.title, url };
            }
        } catch {
            // Fall back to fetching the HTML directly.
        }
    }

    const { response, url: finalUrl } = await fetchFollowingRedirects(url, dependencies);

    if (!response.ok) {
        await response.body?.cancel();

        throw new LunoraError("UNPROCESSABLE", `The page answered ${String(response.status)} ${response.statusText}`.trim());
    }

    const mimeType = baseMimeType(response.headers.get("content-type") ?? "text/html") || "text/html";
    const bytes = await readCapped(response, dependencies.bodyTimeoutMs ?? URL_BODY_READ_TIMEOUT_MS);
    const extracted = await documentToText(bytes, mimeType, dependencies.parse);
    const text = extracted.trim();

    if (!text) {
        throw new LunoraError("UNPROCESSABLE", "The page has no readable text");
    }

    return { mimeType, text, title: isHtmlMimeType(mimeType) ? htmlTitle(new TextDecoder().decode(bytes)) : undefined, url: finalUrl };
};

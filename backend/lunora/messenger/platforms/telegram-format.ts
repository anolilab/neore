export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** True when every inline-code backtick before this point has its closing one. */
const hasClosedCode = (text: string): boolean => text.split("`").length % 2 === 1;

/**
 * Splits `line` into pieces of at most `size` characters without dropping any
 * character: a cut at a space keeps that space at the start of the next piece,
 * so the pieces joined back together are exactly `line`. Unlike `splitMessage`,
 * which trims the remainder, this keeps the spaces inside a code line.
 */
export const splitLossless = (line: string, size: number, inlineCode = true): string[] => {
    const pieces: string[] = [];
    let rest = line;

    while (rest.length > size) {
        // Never cut between the halves of a surrogate pair (an emoji): that would corrupt both.
        // A code point above 0xFFFF starting just before the cut is a surrogate pair the cut would split.
        // A piece of at least one character is always kept, so a cut never comes out empty.
        const surrogateSafe = (at: number) => {
            const before = at - 1;

            return before > 0 && (rest.codePointAt(before) ?? 0) > 0xff_ff ? before : at;
        };
        let cut = rest.lastIndexOf(" ", size);

        // Never cut inside an inline code span: step back to an earlier space outside one.
        while (inlineCode && cut > 0 && !hasClosedCode(rest.slice(0, cut))) {
            cut = rest.lastIndexOf(" ", cut - 1);
        }

        // No safe cut exists (a code span longer than the piece): cut at the limit. The
        // characters stay exactly as written; only that chunk's code formatting can be lost.
        if (cut <= 0) {
            cut = surrogateSafe(size);
        }

        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }

    pieces.push(rest);

    return pieces;
};

export interface TelegramChunk {
    html: string;
    source: string;
}

/** A piece of a block. `joinWith`: what sits between it and the text before it, when they share a chunk. */
interface Piece extends TelegramChunk {
    /** A code piece that continues the block's previous piece: in one chunk they share a single `<pre>`. */
    continuesCode?: boolean;
    joinWith: string;
}

interface Block {
    /** Blank lines before this block in the reply. */
    blanks: number;
    /** False for a fence the reply never closed: the plain source must not gain a closing fence. */
    closed?: boolean;
    code: boolean;
    /** The opening fence's backtick count: a longer fence can hold a shorter one as code. */
    fence?: number;
    /** The language tag on a fenced block's opening line, kept for the plain-text retry. */
    info?: string;
    lines: string[];
}

const PRE_OPEN = "<pre>";
const PRE_CLOSE = "</pre>";

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const INLINE_CODE = /(`[^\n`]+`)/;
const BOLD = /\*\*(?!\s)([^*\n]+)\*\*/g;
const ITALIC = /(?<![\w*])\*(?!\s)([^\n*]+)\*(?![\w*])/g;
const HEADING = /^#{1,6} (.*)$/;
const BULLET = /^( *)[-*+] +/;
const HTTP_URL_START = /^https?:\/\//;
const WHITESPACE = /\s/;

/**
 * Bounds on what a link can span. Without them, every stray `[` in a long reply scans to the end of
 * the reply for its `](`, and that makes formatting quadratic in the reply length.
 */
const MAX_LINK_LABEL = 500;
const MAX_LINK_URL = 2048;

/**
 * A `[label](https://…)` starting at `open`, or undefined. The URL may contain
 * balanced parentheses (`…/Function_(mathematics)`).
 */
const parseLink = (text: string, open: number): { end: number; label: string; url: string } | undefined => {
    const search = text.slice(open, open + MAX_LINK_LABEL + 2);
    const found = search.indexOf("](");

    if (found === -1) {
        return undefined;
    }

    const close = open + found;

    const label = text.slice(open + 1, close);
    const urlStart = close + 2;

    if (label.includes("]") || label.includes("\n") || !HTTP_URL_START.test(text.slice(urlStart, urlStart + 8))) {
        return undefined;
    }

    let depth = 0;

    for (let at = urlStart; at < text.length && at - urlStart <= MAX_LINK_URL; at += 1) {
        const char = text.charAt(at);

        if (WHITESPACE.test(char)) {
            return undefined;
        }

        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            if (depth === 0) {
                return { end: at + 1, label, url: text.slice(urlStart, at) };
            }

            depth -= 1;
        }
    }

    return undefined;
};

/**
 * Walks `text`, rendering links with `onLink` and everything between them with
 * `onText`. Link URLs never reach `onText`, so emphasis cannot rewrite them.
 */
const linkify = (text: string, onText: (plain: string) => string, onLink: (label: string, url: string) => string): string => {
    let out = "";
    let index = 0;
    let open = text.indexOf("[");

    while (open !== -1) {
        const link = parseLink(text, open);

        if (link) {
            out += onText(text.slice(index, open)) + onLink(link.label, link.url);
            index = link.end;
            open = text.indexOf("[", index);
        } else {
            open = text.indexOf("[", open + 1);
        }
    }

    return out + onText(text.slice(index));
};

const emphasis = (text: string): string => text.replaceAll(BOLD, "<b>$1</b>").replaceAll(ITALIC, "<i>$1</i>");

const LINK_SLOT = /(\d+)/g;

/**
 * Emphasis over a whole plain segment, so `*see [docs](url)*` closes around its link. Links are
 * swapped for slots first: the URL never reaches the emphasis pass, and the slot cannot split a marker.
 */
const inlineText = (plain: string): string => {
    const links: string[] = [];
    const withSlots = linkify(
        plain,
        (text) => text,
        (label, url) => {
            links.push(`<a href="${url.replaceAll('"', "&quot;")}">${emphasis(label)}</a>`);

            return `${links.length - 1}`;
        },
    );

    return emphasis(withSlots).replaceAll(LINK_SLOT, (_, index: string) => links[Number(index)] ?? "");
};

const inline = (text: string): string =>
    text
        .split(INLINE_CODE)
        .map((part, index) => {
            if (index % 2 === 1) {
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
            }

            return inlineText(escapeHtml(part));
        })
        .join("");

const renderLine = (line: string): string => {
    const heading = HEADING.exec(line);

    if (heading) {
        return `<b>${inline(heading[1] as string)}</b>`;
    }

    return inline(line.replace(BULLET, "$1• "));
};

/**
 * A closing fence is a line of backticks and nothing else, at least as long as the opening
 * fence: a shorter run inside a longer block is code, not the end of it.
 */
const isClosingFence = (line: string, openLength: number): boolean => {
    const trimmed = line.trim();

    return trimmed.length >= openLength && [...trimmed].every((char) => char === "`");
};

const LEADING_BACKTICKS = /^`+/;

const fenceLength = (line: string): number => line.trimStart().length - line.trimStart().replace(LEADING_BACKTICKS, "").length;

/** Blocks are fenced code (kept whole) and runs of lines between blank lines. */
const toBlocks = (markdown: string): Block[] => {
    const blocks: Block[] = [];
    let current: string[] = [];
    let currentBlanks = 0;
    let fence: string[] | undefined;
    let fenceInfo = "";
    let fenceBlanks = 0;
    let openLength = 3;
    // Blank lines seen since the last block: they are the gap before the next one.
    let blanks = 0;

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        blocks.push({ blanks: currentBlanks, code: false, lines: current });
        current = [];
    };

    for (const line of markdown.split("\n")) {
        if (fence) {
            if (isClosingFence(line, openLength)) {
                blocks.push({ blanks: fenceBlanks, closed: true, code: true, fence: openLength, info: fenceInfo, lines: fence });
                fence = undefined;
            } else {
                fence.push(line);
            }
        } else if (line.trimStart().startsWith("```")) {
            flush();
            fence = [];
            fenceBlanks = blanks;
            blanks = 0;
            openLength = Math.max(3, fenceLength(line));
            fenceInfo = line.trimStart().slice(openLength).trim();
        } else if (line.trim() === "") {
            flush();
            blanks += 1;
        } else {
            if (current.length === 0) {
                currentBlanks = blanks;
                blanks = 0;
            }

            current.push(line);
        }
    }

    if (fence) {
        blocks.push({ blanks: fenceBlanks, code: true, fence: openLength, info: fenceInfo, lines: fence });
    }

    flush();

    return blocks;
};

const openFence = (block: Block): string => `${"`".repeat(block.fence ?? 3)}${block.info ?? ""}\n`;
const closeFence = (block: Block): string => (block.closed ? `\n${"`".repeat(block.fence ?? 3)}` : "");

const renderBlock = (block: Block, lines: string[]): TelegramChunk =>
    block.code
        ? { html: `<pre>${escapeHtml(lines.join("\n"))}</pre>`, source: `${openFence(block)}${lines.join("\n")}${closeFence(block)}` }
        : { html: lines.map((line) => renderLine(line)).join("\n"), source: lines.join("\n") };

/** The join before a block: its blank lines, and at least one blank line between blocks. */
const blankGap = (block: Block): string => "\n".repeat(Math.max(1, block.blanks) + 1);

/** A part of a split block: for code the plain source is the bare code, fenced once by `splitBlock`. */
const renderPart = (block: Block, lines: string[]): TelegramChunk => {
    const rendered = renderBlock(block, lines);

    return block.code ? { ...rendered, source: lines.join("\n") } : rendered;
};

/** Pieces of one block, each rendering to at most `limit` characters. */
const splitBlock = (block: Block, limit: number): Piece[] => {
    const whole = renderBlock(block, block.lines);

    if (whole.html.length <= limit) {
        return [{ ...whole, joinWith: blankGap(block) }];
    }

    const pieces: Piece[] = [];
    let current: string[] = [];
    // A block starts after its blank lines; a line within the block follows a newline.
    let joinWith = blankGap(block);

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        pieces.push({ ...renderPart(block, current), joinWith });
        current = [];
        joinWith = "\n";
    };

    for (const line of block.lines) {
        if (current.length > 0 && renderBlock(block, [...current, line]).html.length > limit) {
            flush();
        }

        if (renderBlock(block, [line]).html.length > limit) {
            // ponytail: an over-long line is cut by source length, not rendered length; a piece Telegram still rejects falls back to plain text
            // Escaping and tags can multiply the length of a line by up to about six, so the source piece is a sixth of the limit.
            // Inside a fenced block a backtick is literal text, not a code delimiter.
            const parts = splitLossless(line, Math.floor(limit / 6), !block.code);

            parts.forEach((part, index) => {
                // Only the first part starts the line, so only it can read as a heading or bullet;
                // the rest are the middle of the line. The parts of one line join with nothing.
                const rendered = index === 0 || block.code ? renderPart(block, [part]) : { html: inline(part), source: part };

                pieces.push({ ...rendered, joinWith: index === 0 ? joinWith : "" });
            });
            joinWith = "\n";
        } else {
            current.push(line);
        }
    }

    flush();

    // The fence belongs to the block, not to each part: open it on the first, close it on the last.
    const first = pieces[0];
    const last = pieces.at(-1);

    if (first && last && block.code) {
        first.source = openFence(block) + first.source;
        last.source += closeFence(block);

        for (const piece of pieces.slice(1)) {
            piece.continuesCode = true;
        }
    }

    return pieces;
};

/**
 * Render agent markdown as Telegram HTML and split it at block boundaries
 * (blank lines, whole code fences, then lines) so each chunk is under `limit`.
 */
export const formatTelegramMessage = (markdown: string, limit: number = TELEGRAM_MESSAGE_LIMIT): TelegramChunk[] => {
    const chunks: TelegramChunk[] = [];
    let current: TelegramChunk | undefined;

    const pieces = toBlocks(markdown).flatMap((block) => splitBlock(block, limit));

    for (const piece of pieces) {
        const separator = piece.joinWith;
        // The previous piece is the block's own, so a continuation shares its code box instead of opening another.
        const sharesPre = piece.continuesCode === true && current?.html.endsWith(PRE_CLOSE) === true;
        const html = sharesPre ? `${(current as TelegramChunk).html.slice(0, -PRE_CLOSE.length)}${separator}${piece.html.slice(PRE_OPEN.length)}` : undefined;

        if (current && html === undefined && current.html.length + separator.length + piece.html.length <= limit) {
            current = { html: `${current.html}${separator}${piece.html}`, source: `${current.source}${separator}${piece.source}` };
        } else if (current && html !== undefined && html.length <= limit) {
            current = { html, source: `${current.source}${separator}${piece.source}` };
        } else {
            if (current) {
                chunks.push(current);
            }

            current = piece;
        }
    }

    if (current) {
        chunks.push(current);
    }

    return chunks;
};

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
        const surrogateSafe = (at: number) => (at > 0 && (rest.codePointAt(at - 1) ?? 0) > 0xff_ff ? at - 1 : at);
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
    joinWith: string;
}

interface Block {
    code: boolean;
    /** The language tag on a fenced block's opening line, kept for the plain-text retry. */
    info?: string;
    lines: string[];
}

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const INLINE_CODE = /(`[^\n`]+`)/;
const BOLD = /\*\*(?!\s)([^*\n]+)\*\*/g;
const ITALIC = /(?<![\w*])\*(?!\s)([^\n*]+)\*(?![\w*])/g;
const HEADING = /^#{1,6} (.*)$/;
const BULLET = /^( *)[-*+] +/;
const HTTP_URL_START = /^https?:\/\//;
const WHITESPACE = /\s/;

/**
 * A `[label](https://…)` starting at `open`, or undefined. The URL may contain
 * balanced parentheses (`…/Function_(mathematics)`).
 */
const parseLink = (text: string, open: number): { end: number; label: string; url: string } | undefined => {
    const close = text.indexOf("](", open);

    if (close === -1) {
        return undefined;
    }

    const label = text.slice(open + 1, close);
    const urlStart = close + 2;

    if (label.includes("]") || label.includes("\n") || !HTTP_URL_START.test(text.slice(urlStart, urlStart + 8))) {
        return undefined;
    }

    let depth = 0;

    for (let at = urlStart; at < text.length; at += 1) {
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

const inline = (text: string): string =>
    text
        .split(INLINE_CODE)
        .map((part, index) => {
            if (index % 2 === 1) {
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
            }

            return linkify(escapeHtml(part), emphasis, (label, url) => `<a href="${url.replaceAll('"', "&quot;")}">${emphasis(label)}</a>`);
        })
        .join("");

const renderLine = (line: string): string => {
    const heading = HEADING.exec(line);

    if (heading) {
        return `<b>${inline(heading[1] as string)}</b>`;
    }

    return inline(line.replace(BULLET, "$1• "));
};

/** Blocks are fenced code (kept whole) and runs of lines between blank lines. */
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

const toBlocks = (markdown: string): Block[] => {
    const blocks: Block[] = [];
    let current: string[] = [];
    let fence: string[] | undefined;
    let fenceInfo = "";
    let openLength = 3;

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        blocks.push({ code: false, lines: current });
        current = [];
    };

    for (const line of markdown.split("\n")) {
        if (fence) {
            if (isClosingFence(line, openLength)) {
                blocks.push({ code: true, info: fenceInfo, lines: fence });
                fence = undefined;
            } else {
                fence.push(line);
            }
        } else if (line.trimStart().startsWith("```")) {
            flush();
            fence = [];
            openLength = Math.max(3, fenceLength(line));
            fenceInfo = line.trimStart().slice(openLength).trim();
        } else if (line.trim() === "") {
            flush();
        } else {
            current.push(line);
        }
    }

    if (fence) {
        blocks.push({ code: true, info: fenceInfo, lines: fence });
    }

    flush();

    return blocks;
};

const renderBlock = (block: Block, lines: string[]): TelegramChunk =>
    block.code
        ? { html: `<pre>${escapeHtml(lines.join("\n"))}</pre>`, source: `\`\`\`${block.info ?? ""}\n${lines.join("\n")}\n\`\`\`` }
        : { html: lines.map((line) => renderLine(line)).join("\n"), source: lines.join("\n") };

/** Pieces of one block, each rendering to at most `limit` characters. */
const splitBlock = (block: Block, limit: number): Piece[] => {
    const whole = renderBlock(block, block.lines);

    if (whole.html.length <= limit) {
        return [{ ...whole, joinWith: "\n\n" }];
    }

    const pieces: Piece[] = [];
    let current: string[] = [];
    // A block starts after a blank line; a line within the block follows a newline.
    let joinWith = "\n\n";

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        pieces.push({ ...renderBlock(block, current), joinWith });
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
                // The parts of one line are the same line: they join with nothing.
                pieces.push({ ...renderBlock(block, [part]), joinWith: index === 0 ? joinWith : "" });
            });
            joinWith = "\n";
        } else {
            current.push(line);
        }
    }

    flush();

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

        if (current && current.html.length + separator.length + piece.html.length <= limit) {
            current = { html: `${current.html}${separator}${piece.html}`, source: `${current.source}${separator}${piece.source}` };
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

export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Splits `line` into pieces of at most `size` characters without dropping any
 * character: a cut at a space keeps that space at the start of the next piece,
 * so the pieces joined back together are exactly `line`. Unlike `splitMessage`,
 * which trims the remainder, this keeps the spaces inside a code line.
 */
export const splitLossless = (line: string, size: number): string[] => {
    const pieces: string[] = [];
    let rest = line;

    while (rest.length > size) {
        let cut = rest.lastIndexOf(" ", size);

        if (cut <= 0) {
            cut = size;
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

interface Block {
    code: boolean;
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
 * Turns `[label](https://…)` into `render(label, url)`. The URL may contain
 * balanced parentheses (`…/Function_(mathematics)`); anything else is left as text.
 */
const linkify = (text: string, render: (label: string, url: string) => string): string => {
    let out = "";
    let index = 0;

    for (let open = text.indexOf("["); open !== -1; open = text.indexOf("[", index)) {
        const close = text.indexOf("](", open);
        const label = close === -1 ? "" : text.slice(open + 1, close);
        const urlStart = close + 2;
        const isLink = close !== -1 && !label.includes("]") && !label.includes("\n") && HTTP_URL_START.test(text.slice(urlStart, urlStart + 8));

        if (!isLink) {
            out += text.slice(index, open + 1);
            index = open + 1;

            continue;
        }

        let depth = 0;
        let end = -1;

        for (let at = urlStart; at < text.length && end === -1; at += 1) {
            const char = text.charAt(at);

            if (WHITESPACE.test(char)) {
                break;
            }

            if (char === "(") {
                depth += 1;
            } else if (char === ")") {
                if (depth === 0) {
                    end = at;
                } else {
                    depth -= 1;
                }
            }
        }

        if (end === -1) {
            out += text.slice(index, open + 1);
            index = open + 1;

            continue;
        }

        out += text.slice(index, open) + render(label, text.slice(urlStart, end));
        index = end + 1;
    }

    return out + text.slice(index);
};

const inline = (text: string): string =>
    text
        .split(INLINE_CODE)
        .map((part, index) => {
            if (index % 2 === 1) {
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
            }

            return linkify(escapeHtml(part), (label, url) => `<a href="${url.replaceAll('"', "&quot;")}">${label}</a>`)
                .replaceAll(BOLD, "<b>$1</b>")
                .replaceAll(ITALIC, "<i>$1</i>");
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
const toBlocks = (markdown: string): Block[] => {
    const blocks: Block[] = [];
    let current: string[] = [];
    let fence: string[] | undefined;

    const flush = () => {
        if (current.length === 0) {
            return;
        }

        blocks.push({ code: false, lines: current });
        current = [];
    };

    for (const line of markdown.split("\n")) {
        if (fence) {
            if (line.trimStart().startsWith("```")) {
                blocks.push({ code: true, lines: fence });
                fence = undefined;
            } else {
                fence.push(line);
            }
        } else if (line.trimStart().startsWith("```")) {
            flush();
            fence = [];
        } else if (line.trim() === "") {
            flush();
        } else {
            current.push(line);
        }
    }

    if (fence) {
        blocks.push({ code: true, lines: fence });
    }

    flush();

    return blocks;
};

const renderBlock = (block: Block, lines: string[]): TelegramChunk =>
    block.code
        ? { html: `<pre>${escapeHtml(lines.join("\n"))}</pre>`, source: `\`\`\`\n${lines.join("\n")}\n\`\`\`` }
        : { html: lines.map((line) => renderLine(line)).join("\n"), source: lines.join("\n") };

/** Pieces of one block, each rendering to at most `limit` characters. */
const splitBlock = (block: Block, limit: number): TelegramChunk[] => {
    const whole = renderBlock(block, block.lines);

    if (whole.html.length <= limit) {
        return [whole];
    }

    const pieces: TelegramChunk[] = [];
    let current: string[] = [];

    for (const line of block.lines) {
        if (current.length > 0 && renderBlock(block, [...current, line]).html.length > limit) {
            pieces.push(renderBlock(block, current));
            current = [];
        }

        if (renderBlock(block, [line]).html.length > limit) {
            // ponytail: an over-long line is cut by source length, not rendered length; a piece Telegram still rejects falls back to plain text
            // Escaping and tags can multiply the length of a line by up to about six, so the source piece is a sixth of the limit.
            const parts = splitLossless(line, Math.floor(limit / 6));

            for (const part of parts) {
                pieces.push(renderBlock(block, [part]));
            }
        } else {
            current.push(line);
        }
    }

    if (current.length > 0) {
        pieces.push(renderBlock(block, current));
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
        if (current && current.html.length + 2 + piece.html.length <= limit) {
            current = { html: `${current.html}\n\n${piece.html}`, source: `${current.source}\n\n${piece.source}` };
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

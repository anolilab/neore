import { splitMessage } from "../lib/types";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramChunk {
    html: string;
    source: string;
}

interface Block {
    code: boolean;
    lines: string[];
}

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const inline = (text: string): string =>
    text
        .split(/(`[^\n`]+`)/)
        .map((part, index) => {
            if (index % 2 === 1) {
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
            }

            return escapeHtml(part)
                .replaceAll(
                    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
                    (_match, label: string, url: string) => `<a href="${url.replaceAll('"', "&quot;")}">${label}</a>`,
                )
                .replaceAll(/\*\*(?!\s)(.+?)\*\*/g, "<b>$1</b>")
                .replaceAll(/(?<![\w*])\*(?!\s)([^\n*]+?)\*(?![\w*])/g, "<i>$1</i>");
        })
        .join("");

const renderLine = (line: string): string => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);

    if (heading) {
        return `<b>${inline(heading[1] as string)}</b>`;
    }

    return inline(line.replace(/^(\s*)[-*+]\s+/, "$1• "));
};

/** Blocks are fenced code (kept whole) and runs of lines between blank lines. */
const toBlocks = (markdown: string): Block[] => {
    const blocks: Block[] = [];
    let current: string[] = [];
    let fence: string[] | undefined;

    const flush = () => {
        if (current.length > 0) {
            blocks.push({ code: false, lines: current });
            current = [];
        }
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
            for (const part of splitMessage(line, Math.floor(limit / 6))) {
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

    for (const piece of toBlocks(markdown).flatMap((block) => splitBlock(block, limit))) {
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

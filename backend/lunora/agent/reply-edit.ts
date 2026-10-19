/**
 * Editing an assistant reply's text in place (`branches.ts#editAssistantReply`).
 *
 * A reply spans several rows (one per step, tool results between them), and
 * the user edits the one text they see. Pure rules only: which row's content
 * changes, and how. The procedure does the reads and writes.
 */

import { joinText } from "./shared";

export interface ContentPart {
    [key: string]: unknown;
    text?: string;
    type: string;
}

export type ReplyContent = string | ContentPart[];

export interface ReplyRow {
    content: ReplyContent;
    role: string;
}

const partsOf = (content: ReplyContent): ContentPart[] => (typeof content === "string" ? [{ text: content, type: "text" }] : content);

/** The reply's visible text, joined the way `message.text` joins it. */
export const replyTextOf = (rows: ReadonlyArray<ReplyRow>): string =>
    joinText(rows.filter((row) => row.role === "assistant").flatMap((row) => partsOf(row.content)) as Parameters<typeof joinText>[0]);

/**
 * The content each row takes once the reply reads `text`, one entry per row:
 * `undefined` keeps the row as it is. `null` when the reply has no text part.
 *
 * The edited text goes into the LAST text part, the answer after any tool
 * calls, and the other text parts are dropped; tool calls, reasoning, files and
 * images stay exactly where they were. Unchanged text writes nothing.
 */
export const rewriteReplyText = (rows: ReadonlyArray<ReplyRow>, text: string): (ReplyContent | undefined)[] | null => {
    const carriers = rows.flatMap((row, rowIndex) => {
        if (row.role !== "assistant") {
            return [];
        }

        return partsOf(row.content).flatMap((part, partIndex) => (part.type === "text" ? [{ partIndex, rowIndex }] : []));
    });
    const last = carriers.at(-1);

    if (!last) {
        return null;
    }

    if (text === replyTextOf(rows)) {
        return rows.map(() => undefined);
    }

    return rows.map((row, rowIndex) => {
        if (carriers.every((carrier) => carrier.rowIndex !== rowIndex)) {
            return undefined;
        }

        if (typeof row.content === "string" && rowIndex === last.rowIndex) {
            return text;
        }

        return partsOf(row.content).flatMap((part, partIndex) => {
            if (part.type !== "text") {
                return [part];
            }

            return rowIndex === last.rowIndex && partIndex === last.partIndex ? [{ ...part, text }] : [];
        });
    });
};

/**
 * Which rows of a thread count as a reply, and where the next scan starts.
 *
 * Rows are ordered by `(order, stepOrder)`. A row still `pending` (a reply being written) is a barrier: nothing
 * at or after it is looked at, so the reply is seen once, when it has settled, and never half-written.
 * Tool rows and failed rows are skipped; so are the watcher's own messages.
 */
import type { ThreadScan } from "./types";

export interface ScanRow {
    _id: string;
    order: number;
    /** `message.role`. */
    role?: string;
    status: string;
    stepOrder: number;
    text?: string;
    tool: boolean;
    userId?: string;
}

/** Longest reply excerpt handed to the run. */
export const REPLY_EXCERPT_CHARS = 500;

const isAfter = (row: ScanRow, after: { order: number; stepOrder: number }): boolean =>
    row.order > after.order || (row.order === after.order && row.stepOrder > after.stepOrder);

const isReply = (row: ScanRow, watcherId: string): boolean =>
    !row.tool && row.status === "success" && (row.role === "assistant" || (row.role === "user" && row.userId !== watcherId));

/** `rowsAscending` is ordered by `(order, stepOrder)`. With no `after` this is a first look: it finds the baseline and reports no reply. */
export const scanThreadRows = (rowsAscending: ScanRow[], after: { order: number; stepOrder: number } | undefined, watcherId: string): ThreadScan => {
    const barrier = rowsAscending.findIndex((row) => row.status === "pending");
    const settled = barrier === -1 ? rowsAscending : rowsAscending.slice(0, barrier);
    const fresh = after === undefined ? settled : settled.filter((row) => isAfter(row, after));
    const last = fresh.at(-1);
    const reply = after === undefined ? undefined : fresh.findLast((row) => isReply(row, watcherId));

    return {
        ...(last && { baseline: { order: last.order, stepOrder: last.stepOrder } }),
        ...(reply && { reply: { id: reply._id, text: (reply.text ?? "").slice(0, REPLY_EXCERPT_CHARS) } }),
    };
};

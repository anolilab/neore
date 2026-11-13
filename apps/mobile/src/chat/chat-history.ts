import type { OlderPageResult } from "../offline/message-read";
import type { MessageRow } from "../offline/types";

/**
 * What a chat screen knows of its history, and how each read changes it. One model for the newest-page read, the fill
 * after it and "Load older messages", so the cursor, the rows and any hole between them never disagree.
 *
 * - The rows on screen are oldest first. The newest of them always come from the latest read of the newest page.
 * - `olderCursor` continues the history just below the oldest row of the run that joins the newest row without a hole:
 * reading from it never returns a row of that run again. `null` once that run reaches the start of the chat;
 * `undefined` while it is not known (only saved rows on screen, or nothing read yet).
 * - `gap`: older rows are kept below a hole. The run from the newest row stops at `anchorId`, and the history below it
 * is read from `cursor` until a page reaches the kept rows. A fill that stops early leaves the gap in place, so the
 * next fill or "Load older messages" goes on from there instead of from a cursor inside the hole.
 */

/** The part of a row the history reads. */
export interface HistoryRow {
    finished?: boolean;
    id: string;
    status: string;
}

export interface HistoryGap {
    /** The oldest row of the run that joins the newest row. */
    anchorId: string;
    /** Where the history below `anchorId` is read from. */
    cursor: string;
    /** The cursor below the kept rows, when they were a run of their own; `undefined` for saved rows painted from the cache. */
    keptCursor: string | null | undefined;
}

export interface ChatHistory<R extends HistoryRow> {
    gap?: HistoryGap;
    olderCursor: string | null | undefined;
    rows: R[];
}

/** One page of older rows, oldest first, and the cursor below it (`null` at the start of the chat). */
export interface HistoryPage<R> {
    olderCursor: string | null;
    rows: R[];
}

/** A row the server holds: rows made on this screen (sending, or sent and not read back yet) are not. */
const isServerRow = (row: HistoryRow): boolean => row.status !== "local" && row.finished !== true;

/** Where "Load older messages" and the fill read next: the hole first, then below the run. `null`: nothing to read. */
export const nextOlderCursor = (history: ChatHistory<HistoryRow>): string | null => {
    if (history.gap !== undefined) {
        return history.gap.cursor;
    }

    // eslint-disable-next-line unicorn/no-null -- null is "nothing older", as the server's cursor says at the start of the chat
    return history.olderCursor ?? null;
};

/** Whether there is anything older to show: a hole to fill, or history below the run. */
export const hasOlder = (history: ChatHistory<HistoryRow>): boolean => nextOlderCursor(history) !== null;

/** The rows of the run that joins the newest row: what may be saved as the chat's newest messages. */
export const newestRun = <R extends HistoryRow>(history: ChatHistory<R>): R[] => {
    const start = history.gap === undefined ? 0 : Math.max(0, history.rows.findIndex((row) => row.id === history.gap?.anchorId));

    return history.rows.slice(start).filter((row) => isServerRow(row));
};

/**
 * A fresh read of the newest page. Rows on screen older than it are kept (rows loaded before, saved rows the cache
 * painted), so they stay when the app goes offline again:
 * - when the screen reaches the page's oldest row, they join it; the cursor below them stays if it was known;
 * - when it does not (more than a page came since, or another branch of the chat is active now), they are kept below
 * a gap, which the fill reads down to, dropping what turns out not to be on the chat's active path;
 * - when the page is the whole chat, nothing older exists, and older rows on screen go.
 * Rows made on this screen are not kept: the page holds their server copies.
 */
export const withNewestPage = <R extends HistoryRow>(history: ChatHistory<R>, page: HistoryPage<R>): ChatHistory<R> => {
    const [oldest] = page.rows;

    if (oldest === undefined) {
        // eslint-disable-next-line unicorn/no-null -- an empty newest page is the whole chat: nothing older
        return { olderCursor: null, rows: [] };
    }

    const pageIds = new Set(page.rows.map((row) => row.id));
    const boundary = history.rows.findIndex((row) => row.id === oldest.id);

    if (boundary !== -1) {
        const kept = history.rows.slice(0, boundary).filter((row) => isServerRow(row) && !pageIds.has(row.id));
        const rows = [...kept, ...page.rows];

        if (kept.length === 0) {
            return { olderCursor: page.olderCursor, rows };
        }

        // An earlier hole is still below the page: it is filled from where it stopped.
        if (history.gap !== undefined && rows.some((row) => row.id === history.gap?.anchorId)) {
            return { gap: history.gap, olderCursor: undefined, rows };
        }

        if (history.olderCursor !== undefined) {
            return { olderCursor: history.olderCursor, rows };
        }

        // Saved rows below the page, not read since: kept, and confirmed by the fill from the page's cursor.
        return page.olderCursor === null
            ? { olderCursor: page.olderCursor, rows: page.rows }
            : { gap: { anchorId: oldest.id, cursor: page.olderCursor, keptCursor: undefined }, olderCursor: undefined, rows };
    }

    // The page does not reach the rows on screen. Below an earlier hole, only that hole's run is kept: its cursor is known.
    const run = history.gap === undefined ? history.rows : newestRun(history);
    const kept = run.filter((row) => isServerRow(row) && !pageIds.has(row.id));

    if (kept.length === 0 || page.olderCursor === null) {
        return { olderCursor: page.olderCursor, rows: page.rows };
    }

    const keptCursor = history.gap === undefined ? history.olderCursor : history.gap.cursor;

    return { gap: { anchorId: oldest.id, cursor: page.olderCursor, keptCursor }, olderCursor: undefined, rows: [...kept, ...page.rows] };
};

/**
 * One older page, read at {@link nextOlderCursor}. Below a hole, it goes right under the run that joins the newest row:
 * - when it reaches the kept rows, the hole is closed; kept rows newer than the newest one it reached are not on the
 * chat's active path (another branch, a deleted message) and go; the cursor below the kept rows takes over;
 * - when it reaches the start of the chat without them, none of the kept rows is on the active path, and they go;
 * - otherwise the hole moves down to the page's oldest row.
 * With no hole, the page extends the run downward.
 *
 * `from` is the cursor the page was read from. A page lands later than it was asked for: when a read of the newest page
 * moved the history meanwhile (a new hole, or a cursor kept from below), the page no longer belongs where it would go,
 * and the history stays as it is.
 */
export const withOlderPage = <R extends HistoryRow>(history: ChatHistory<R>, page: HistoryPage<R>, from: string): ChatHistory<R> => {
    if (nextOlderCursor(history) !== from) {
        return history;
    }

    const onScreen = new Set(history.rows.map((row) => row.id));

    if (history.gap === undefined) {
        return { olderCursor: page.olderCursor, rows: [...page.rows.filter((row) => !onScreen.has(row.id)), ...history.rows] };
    }

    const { anchorId, keptCursor } = history.gap;
    const at = Math.max(0, history.rows.findIndex((row) => row.id === anchorId));
    const kept = history.rows.slice(0, at);
    const run = history.rows.slice(at);
    const runIds = new Set(run.map((row) => row.id));
    const pageIds = new Set(page.rows.map((row) => row.id));
    const lastReached = kept.findLastIndex((row) => pageIds.has(row.id));

    if (lastReached === -1) {
        const below = page.rows.filter((row) => !runIds.has(row.id));
        const [pageOldest] = page.rows;

        if (pageOldest === undefined || page.olderCursor === null) {
            return { olderCursor: page.olderCursor, rows: [...below, ...run] };
        }

        return { gap: { anchorId: pageOldest.id, cursor: page.olderCursor, keptCursor }, olderCursor: undefined, rows: [...kept, ...below, ...run] };
    }

    const joined = kept.slice(0, lastReached + 1);
    const joinedIds = new Set(joined.map((row) => row.id));
    const reachedInPage = page.rows.findLastIndex((row) => joinedIds.has(row.id));
    const between = page.rows.slice(reachedInPage + 1).filter((row) => !runIds.has(row.id));

    return { olderCursor: keptCursor === undefined ? page.olderCursor : keptCursor, rows: [...joined, ...between, ...run] };
};

/** How many rows a chat fills to after it opens, the newest page painted first: as far back as it opened before. */
export const OPEN_FILL_ROWS = 200;

/** Older pages one fill reads at most. A hole it has not closed by then stays marked, and the next fill goes on with it. */
export const MAX_FILL_PAGES = 10;

/** The page reads of {@link fillHistory}. */
const readFill = async <R extends HistoryRow>({
    fetchOlder,
    fillTo,
    read,
    update,
}: {
    fetchOlder: (cursor: string) => Promise<HistoryPage<R> | undefined>;
    fillTo: number;
    read: () => ChatHistory<R>;
    update: (apply: (history: ChatHistory<R>) => ChatHistory<R>) => void;
}): Promise<"filled" | "stopped"> => {
    for (let pages = 0; pages < MAX_FILL_PAGES; pages += 1) {
        const history = read();
        const cursor = nextOlderCursor(history);

        if (cursor === null || (history.gap === undefined && history.rows.length >= fillTo)) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before it
        const page = await fetchOlder(cursor);

        if (page === undefined) {
            return "stopped";
        }

        update((current) => withOlderPage(current, page, cursor));
    }

    return "filled";
};

/**
 * Reads older pages after the newest one is painted: first down through a hole, then, while the screen holds fewer
 * than `fillTo` rows, below the run. Each page is applied to the history as it is when the page lands (`update`).
 * `fetchOlder` answers `undefined` when the fill must stop (the screen moved on, the chat was refused, the network
 * failed); the history then keeps its hole, if any, for the next fill. However it ends, `save` gets the run that joins
 * the newest row, the chat's newest messages as now read, for the cache.
 */
export const fillHistory = async <R extends HistoryRow>({
    fetchOlder,
    fillTo,
    read,
    save,
    update,
}: {
    fetchOlder: (cursor: string) => Promise<HistoryPage<R> | undefined>;
    fillTo: number;
    read: () => ChatHistory<R>;
    save: (rows: R[]) => void;
    update: (apply: (history: ChatHistory<R>) => ChatHistory<R>) => void;
}): Promise<"filled" | "stopped"> => {
    const outcome = await readFill({ fetchOlder, fillTo, read, update });

    save(newestRun(read()));

    return outcome;
};

/**
 * What an older-page read gives the history: the page, or `undefined`. A refused chat goes to `onRefused`, as a refused
 * newest-page read does (the chat is cleared, not left on screen); a failure to `onFailure`; a read the screen moved on
 * from is dropped.
 */
export const olderPageOf = (
    result: OlderPageResult,
    { onFailure, onRefused }: { onFailure: (message: string) => void; onRefused: () => void },
): HistoryPage<MessageRow> | undefined => {
    switch (result.kind) {
        case "failed": {
            onFailure(result.message);

            return undefined;
        }
        case "page": {
            return { olderCursor: result.olderCursor, rows: result.rows };
        }
        case "refused": {
            onRefused();

            return undefined;
        }
        case "unreachable": {
            onFailure("Could not load older messages. You appear to be offline.");

            return undefined;
        }
        default: {
            return undefined;
        }
    }
};

/**
 * Who shows "Loading older messages": each fill or "Load older messages" press takes it over, and only the one that
 * holds it last may end it, so a fill superseded by a newer one cannot clear the newer one's state.
 */
export const createLoadingOwner = (setLoading: (isLoading: boolean) => void) => {
    let owner: symbol | undefined;

    return {
        begin: (): () => void => {
            const token = Symbol("older-history read");

            owner = token;
            setLoading(true);

            return () => {
                if (owner !== token) {
                    return;
                }

                owner = undefined;
                setLoading(false);
            };
        },
    };
};

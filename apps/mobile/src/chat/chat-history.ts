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
 * - A refresh that opens a hole while one is open keeps every row on screen: the rows below the new hole hold the old
 * one (`keptGap`), so the run above the old hole stays shown until a page reaches it, and the fill then goes on from the
 * old hole's cursor instead of reading that run again.
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

    /**
     * A hole within the kept rows: they are a run the server served down to its `anchorId`, above older rows kept below
     * it. Set when a refresh opened this hole while that one was open; `keptCursor` is then `undefined`.
     */
    keptGap?: HistoryGap;
}

export interface ChatHistory<R extends HistoryRow> {
    /**
     * How many rows the fill after the newest page reads down to (a chat just opened), while that is not reached yet and
     * something older is left. A fill that stops early leaves it, so the next read goes on filling.
     */
    fillTarget?: number;
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

/** The rows on screen as the merges read them: the confirmed run that joins the newest row, and the rows kept below it. */
interface Split<R> {
    /** Rows below the run whose place on the chat's active path the server has not confirmed against the run. */
    kept: R[];
    /** The cursor below `kept[0]` when the kept rows are one run the server served; `undefined` when not known (saved rows). */
    keptCursor: string | null | undefined;
    /** A hole within the kept rows (see {@link HistoryGap.keptGap}). */
    keptGap: HistoryGap | undefined;
    /** The run that joins the newest row: the server served it without a hole, down to its oldest row. */
    run: R[];
}

const splitOf = <R extends HistoryRow>(history: ChatHistory<R>): Split<R> => {
    if (history.gap !== undefined) {
        const { anchorId, keptCursor, keptGap } = history.gap;
        const at = Math.max(0, history.rows.findIndex((row) => row.id === anchorId));

        return { kept: history.rows.slice(0, at), keptCursor, keptGap, run: history.rows.slice(at) };
    }

    // Rows the cache painted, not read since: nothing on screen is confirmed yet.
    if (history.olderCursor === undefined) {
        return { kept: history.rows, keptCursor: undefined, keptGap: undefined, run: [] };
    }

    return { kept: [], keptCursor: undefined, keptGap: undefined, run: history.rows };
};

/** What is known below the kept rows: the cursor below them, or the hole within them. */
interface KeptState {
    cursor: string | null | undefined;
    gap: HistoryGap | undefined;
}

const gapOf = (anchorId: string, cursor: string, kept: KeptState): HistoryGap => {
    if (kept.gap === undefined) {
        return { anchorId, cursor, keptCursor: kept.cursor };
    }

    return { anchorId, cursor, keptCursor: kept.cursor, keptGap: kept.gap };
};

/**
 * One page the server served, oldest first and without a hole, that ends right below `run` (or is the newest page, when
 * `run` is empty), merged with the rows kept below it. The page tells where the kept rows go:
 * - kept rows newer than the oldest one the page holds, and not in it, are not on the chat's active path (another
 * branch, a deleted message): nothing the page skipped lies between its rows and the run, so they go;
 * - kept rows older than the oldest one the page holds go below the page, in their order. If there are none, the run now
 * reaches the page's oldest row and the cursor below it takes over;
 * - those older rows join the run only when they are one run the server served (`keptCursor`) and the page's oldest row
 * is the newest of them it reached: then nothing lies between, and the cursor below them takes over. Otherwise they
 * stay below a hole at the page's oldest row, read from the page's cursor until a page reaches them;
 * - a hole within the kept rows (`keptGap`) stays while its anchor is kept. When the page joins the run above it, the
 * history reads on from that hole; when the page holds or dropped that run, the hole goes and what lay below it counts;
 * - at the start of the chat (`olderCursor: null`), rows older than the page are not on the chat, and go.
 * No row of the page is lost, none of the run is read again, and the cursor stays below the run's oldest row.
 */
const merged = <R extends HistoryRow>({ kept, keptCursor, keptGap, run }: Split<R>, page: HistoryPage<R>): ChatHistory<R> => {
    const runIds = new Set(run.map((row) => row.id));
    const pageRows = page.rows.filter((row) => !runIds.has(row.id));
    const [pageOldest] = pageRows;
    const body = [...pageRows, ...run];

    if (pageOldest === undefined || page.olderCursor === null) {
        return { olderCursor: page.olderCursor, rows: body };
    }

    const pageIds = new Set(pageRows.map((row) => row.id));
    const candidates = kept.filter((row) => isServerRow(row) && !runIds.has(row.id));
    const firstReached = candidates.findIndex((row) => pageIds.has(row.id));
    const below = firstReached === -1 ? candidates : candidates.slice(0, firstReached);

    if (below.length === 0) {
        return { olderCursor: page.olderCursor, rows: body };
    }

    const rows = [...below, ...body];
    const isJoined = candidates[firstReached]?.id === pageOldest.id;
    const stillKept = new Set(below.map((row) => row.id));

    if (isJoined) {
        stillKept.add(pageOldest.id);
    }

    let state: KeptState = { cursor: keptCursor, gap: keptGap };

    while (state.gap !== undefined && !stillKept.has(state.gap.anchorId)) {
        state = { cursor: state.gap.keptCursor, gap: state.gap.keptGap };
    }

    if (isJoined && state.gap !== undefined) {
        return { gap: state.gap, olderCursor: undefined, rows };
    }

    if (isJoined && state.cursor !== undefined) {
        return { olderCursor: state.cursor, rows };
    }

    return { gap: gapOf(pageOldest.id, page.olderCursor, state), olderCursor: undefined, rows };
};

/**
 * A fresh read of the newest page. Rows on screen older than it are kept (rows loaded before, saved rows the cache
 * painted), so they stay when the app goes offline again:
 * - when the run on screen holds the page's oldest row, the page replaces the run from there up; a hole below the run
 * and the cursor stay as they were;
 * - otherwise the run is no longer known to join the newest row, and the page is {@link merged} with the rows on screen;
 * - when the page is the whole chat, nothing older exists, and older rows on screen go.
 * Rows made on this screen are not kept: the page holds their server copies.
 */
const newestPageOf = <R extends HistoryRow>(history: ChatHistory<R>, page: HistoryPage<R>): ChatHistory<R> => {
    const [oldest] = page.rows;

    if (oldest === undefined || page.olderCursor === null) {
        // eslint-disable-next-line unicorn/no-null -- the newest page is the whole chat: nothing older
        return { olderCursor: null, rows: page.rows };
    }

    const split = splitOf(history);
    const boundary = split.run.findIndex((row) => row.id === oldest.id);

    if (boundary !== -1) {
        const pageIds = new Set(page.rows.map((row) => row.id));
        const runBelow = split.run.slice(0, boundary).filter((row) => isServerRow(row) && !pageIds.has(row.id));

        return { ...history, rows: [...split.kept, ...runBelow, ...page.rows] };
    }

    // The page does not reach the run: every row on screen becomes a kept row, with what is known below them (the cursor
    // below the run, or the hole under it), so the run above an open hole stays shown until a page reaches it.
    return merged({ kept: history.rows, keptCursor: history.olderCursor, keptGap: history.gap, run: [] }, page);
};

/**
 * One older page, read at {@link nextOlderCursor}. With no hole, it extends the run downward. Below a hole, it goes right
 * under the run that joins the newest row and is {@link merged} with the kept rows.
 *
 * `from` is the cursor the page was read from. A page lands later than it was asked for: when a read of the newest page
 * moved the history meanwhile (a new hole, or a cursor kept from below), the page no longer belongs where it would go,
 * and the history stays as it is.
 */
const olderPageApplied = <R extends HistoryRow>(history: ChatHistory<R>, page: HistoryPage<R>, from: string): ChatHistory<R> => {
    if (nextOlderCursor(history) !== from) {
        return history;
    }

    if (history.gap === undefined) {
        const onScreen = new Set(history.rows.map((row) => row.id));

        return { olderCursor: page.olderCursor, rows: [...page.rows.filter((row) => !onScreen.has(row.id)), ...history.rows] };
    }

    return merged(splitOf(history), page);
};

/**
 * Carries the fill target over a read, until it is reached or nothing older is left. While a hole is open the target
 * stays: the rows kept below it may not be on the chat's active path (another branch), and go when a page reaches past
 * them, so only the run that joins the newest row, once no hole is left, counts toward it.
 */
const withFillCarried = <R extends HistoryRow>(before: ChatHistory<R>, after: ChatHistory<R>): ChatHistory<R> => {
    const { fillTarget, ...rest } = after;
    const target = before.fillTarget ?? fillTarget;
    const isReached = target !== undefined && after.gap === undefined && newestRun(after).length >= target;

    if (target === undefined || isReached || nextOlderCursor(after) === null) {
        return rest;
    }

    return { ...rest, fillTarget: target };
};

/** A fresh read of the newest page (see {@link newestPageOf}); an unfinished fill target is carried over. */
export const withNewestPage = <R extends HistoryRow>(history: ChatHistory<R>, page: HistoryPage<R>): ChatHistory<R> =>
    withFillCarried(history, newestPageOf(history, page));

/** One older page read from `from` (see {@link olderPageApplied}); an unfinished fill target is carried over. */
export const withOlderPage = <R extends HistoryRow>(history: ChatHistory<R>, page: HistoryPage<R>, from: string): ChatHistory<R> => {
    const next = olderPageApplied(history, page, from);

    return next === history ? history : withFillCarried(history, next);
};

/** Sets the rows the fill reads down to: a chat just opened fills to {@link OPEN_FILL_ROWS}. */
export const withFillTarget = <R extends HistoryRow>(history: ChatHistory<R>, fillTarget: number): ChatHistory<R> =>
    withFillCarried({ ...history, fillTarget }, history);

/** Whether a fill should run after a read: a hole to close, or a fill target not reached with something older left. */
export const requiresFill = (history: ChatHistory<HistoryRow>): boolean => history.gap !== undefined || history.fillTarget !== undefined;

/** How many rows a chat fills to after it opens, the newest page painted first: as far back as it opened before. */
export const OPEN_FILL_ROWS = 200;

/** Older pages one fill reads at most. A hole it has not closed by then stays marked, and the next fill goes on with it. */
export const MAX_FILL_PAGES = 10;

interface FillInput<R extends HistoryRow> {
    fetchOlder: (cursor: string) => Promise<HistoryPage<R> | undefined>;
    /** Whether the fill may go on: false once the screen left this chat. A fill that is not current reads and applies nothing more. */
    isCurrent?: () => boolean;
    read: () => ChatHistory<R>;
    update: (apply: (history: ChatHistory<R>) => ChatHistory<R>) => void;
}

/** The page reads of {@link fillHistory}. */
const readFill = async <R extends HistoryRow>({ fetchOlder, isCurrent = () => true, read, update }: FillInput<R>): Promise<"filled" | "stopped"> => {
    for (let pages = 0; pages < MAX_FILL_PAGES; pages += 1) {
        if (!isCurrent()) {
            return "stopped";
        }

        const history = read();
        const cursor = nextOlderCursor(history);

        if (cursor === null || !requiresFill(history)) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before it
        const page = await fetchOlder(cursor);

        if (page === undefined || !isCurrent()) {
            return "stopped";
        }

        update((current) => withOlderPage(current, page, cursor));
    }

    return "filled";
};

/**
 * Reads older pages after the newest one is painted: first down through a hole, then, while the history's fill target
 * is not reached, below the run. Each page is applied to the history as it is when the page lands (`update`).
 * `fetchOlder` answers `undefined` when the fill must stop (the screen moved on, the chat was refused, the network
 * failed); the history then keeps its hole, if any, for the next fill. However it ends, `save` gets the run that joins
 * the newest row, the chat's newest messages as now read, for the cache.
 */
export const fillHistory = async <R extends HistoryRow>({ save, ...input }: FillInput<R> & { save: (rows: R[]) => void }): Promise<"filled" | "stopped"> => {
    const outcome = await readFill(input);

    save(newestRun(input.read()));

    return outcome;
};

/** One fill a {@link createFillRunner} runs: the chat it fills, whether it may go on, and the fill itself. */
interface FillRequest<K> {
    fill: (key: K, isCurrent: () => boolean) => Promise<unknown>;
    isCurrent: () => boolean;
    key: K;
}

/**
 * Runs at most one fill of a screen at a time. A read that asks for a fill while one runs for the same chat does not
 * start another (both would read the same cursors): the running fill reads the history afresh before each page, so it
 * goes on from what that read left, and once it ends it runs again, in case it stopped before that read landed. A
 * request for another chat, or one no longer current, stops the running fill at its next check.
 */
export const createFillRunner = <K>() => {
    let latest: FillRequest<K> | undefined;
    let isRequested = false;
    let running: Promise<void> | undefined;

    const drain = async (): Promise<void> => {
        try {
            while (isRequested && latest !== undefined) {
                isRequested = false;

                const { fill, key } = latest;

                // eslint-disable-next-line no-await-in-loop -- one fill at a time is the point
                await fill(key, () => latest?.key === key && latest.isCurrent());
            }
        } finally {
            running = undefined;
        }
    };

    return {
        request: async (request: FillRequest<K>): Promise<void> => {
            latest = request;
            isRequested = true;
            running ??= drain();

            await running;
        },
    };
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

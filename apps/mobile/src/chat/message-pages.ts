/** Messages in a history page: the newest page on open, and each page "Load older messages" adds. */
export const HISTORY_PAGE_SIZE = 100;

/** One page of a thread's messages: the server lists its pages newest first, and each page is oldest first inside. */
export interface MessagePage<M> {
    continueCursor: string | null;
    isDone: boolean;
    page: M[];
}

/** Reads one page of a thread's messages, from the newest page when the cursor is null. */
export type MessagePageFetch<M> = (cursor: string | null, pageSize: number) => Promise<MessagePage<M>>;

/**
 * What a chat shows when it opens or re-reads: the newest page only, in one request. The rest of the history is
 * fetched a page at a time by "Load older messages", from the cursor returned here (null once there is no more).
 */
export const readNewestRows = async <M, R>(fetchPage: MessagePageFetch<M>, toRow: (message: M) => R): Promise<{ olderCursor: string | null; rows: R[] }> => {
    // eslint-disable-next-line unicorn/no-null -- the query takes null for its first page
    const page = await fetchPage(null, HISTORY_PAGE_SIZE);

    // eslint-disable-next-line unicorn/no-null -- null is "no older page" on the screen
    return { olderCursor: page.isDone ? null : page.continueCursor, rows: page.page.map((message) => toRow(message)) };
};

/** How many rows a chat fills to after it opens, the newest page painted first: as far back as it opened before. */
export const OPEN_FILL_ROWS = 200;

/** Older pages one fill fetches at most, whatever it is filling. */
export const MAX_FILL_PAGES = 10;

/** An older page as the screen shows it: rows oldest first, and the cursor of the page before it (null at the start). */
export interface OlderPage<R> {
    olderCursor: string | null;
    rows: R[];
}

/** Puts a page of older rows right before the row `anchorId`, leaving out the ones already on screen. */
export const insertBefore = <R extends { id: string }>(rows: ReadonlyArray<R>, anchorId: string, page: ReadonlyArray<R>): R[] => {
    const onScreen = new Set(rows.map((row) => row.id));
    const added = page.filter((row) => !onScreen.has(row.id));
    const at = rows.findIndex((row) => row.id === anchorId);

    if (at === -1) {
        return [...added, ...rows];
    }

    return [...rows.slice(0, at), ...added, ...rows.slice(at)];
};

/**
 * Fetches older pages after the newest one is on screen, a page at a time from `cursor`, each placed right before the
 * oldest row fetched so far (`anchorId`). It goes on while older rows on screen are not reached yet (a gap after a
 * refresh: it stops at the first page that reaches them) or while the screen holds fewer than `fillTo` rows (a chat
 * just opened), at most {@link MAX_FILL_PAGES} pages. `fetchOlder` answers `undefined` when the fill must stop (the
 * screen moved on, the network failed); the cursor is then not to be used.
 */
export const fillHistory = async <R extends { id: string }>({
    anchorId,
    cursor,
    fetchOlder,
    fillTo,
    read,
    write,
}: {
    anchorId: string;
    cursor: string | null;
    fetchOlder: (cursor: string) => Promise<OlderPage<R> | undefined>;
    fillTo: number;
    read: () => ReadonlyArray<R>;
    write: (update: (rows: R[]) => R[]) => void;
}): Promise<{ cursor: string | null; isStopped: boolean }> => {
    let anchor = anchorId;
    let next = cursor;

    for (let pages = 0; next !== null && pages < MAX_FILL_PAGES; pages += 1) {
        const onScreen = read();
        const hasGap = onScreen.findIndex((row) => row.id === anchor) > 0;

        if (!hasGap && onScreen.length >= fillTo) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before it
        const page = await fetchOlder(next);

        if (page === undefined) {
            return { cursor: next, isStopped: true };
        }

        const shown = new Set(read().map((row) => row.id));
        const reachesOlder = hasGap && page.rows.some((row) => shown.has(row.id));
        const at = anchor;

        write((rows) => insertBefore(rows, at, page.rows));
        anchor = page.rows[0]?.id ?? anchor;
        next = page.olderCursor;

        if (reachesOlder) {
            break;
        }
    }

    return { cursor: next, isStopped: false };
};

/** The part of a message row the refresh merge reads. */
export interface FreshRow {
    finished?: boolean;
    id: string;
    status: string;
}

/** Whether the rows on screen reach the fresh read's oldest row, so the older rows before it can be kept. */
export const isOldestFreshRowOnScreen = <T extends FreshRow>(current: ReadonlyArray<T>, fresh: ReadonlyArray<T>): boolean => {
    const oldest = fresh[0];

    return oldest !== undefined && current.some((row) => row.id === oldest.id);
};

/**
 * Replaces the newest rows with a fresh read. Rows loaded before the read's oldest row are kept when older pages were
 * loaded on screen: the cursor on screen then continues after them. They are placed by their position in the list,
 * which is the server's pagination order, not by creation time: messages can share a millisecond and the clock is not
 * the order the pages come in. If the read's oldest row is not on screen, nothing can be placed before it, so the
 * older rows are dropped and the cursor from the fresh read takes over. Local rows are never kept: a fresh read holds
 * their server copies, or they are still being written.
 */
export const withFreshRows = <T extends FreshRow>(current: ReadonlyArray<T>, fresh: ReadonlyArray<T>, hasOlderPages: boolean): T[] => {
    const boundary = current.findIndex((row) => row.id === fresh[0]?.id);

    if (!hasOlderPages || boundary === -1) {
        return [...fresh];
    }

    const freshIds = new Set(fresh.map((row) => row.id));
    const older = current.slice(0, boundary).filter((row) => !freshIds.has(row.id) && row.status !== "local" && !row.finished);

    return [...older, ...fresh];
};

/** What a fresh read of the newest page does to the rows on screen. */
export interface FreshMerge<T> {
    /**
     * Older rows are kept but the fresh page does not reach them: more than a page of messages came after them. The
     * pages in between are still to be fetched (`fillHistory`); until then the kept rows sit right before the fresh ones.
     */
    hasGap: boolean;
    /** Whether the cursor on screen still continues the kept rows: only after "Load older messages" added them. */
    keepsCursor: boolean;
    rows: T[];
}

/**
 * Merges a fresh read of the newest page into the rows on screen, keeping the older server rows instead of dropping
 * them: rows "Load older messages" added, and the saved rows the cache painted, which must stay on screen when the app
 * goes offline again. The fresh read is the newest page, so every row on screen it does not hold is older (or gone).
 * Rows before the fresh read's oldest row are kept when the screen reaches it; when it does not, all older rows are
 * kept and the merge reports the gap. Local and finished rows are never kept: the fresh read holds their server copies.
 */
export const mergeFreshRead = <T extends FreshRow>(current: ReadonlyArray<T>, fresh: ReadonlyArray<T>, hasLoadedOlder: boolean): FreshMerge<T> => {
    if (fresh.length === 0) {
        return { hasGap: false, keepsCursor: false, rows: [] };
    }

    const boundary = current.findIndex((row) => row.id === fresh[0]?.id);
    const freshIds = new Set(fresh.map((row) => row.id));
    const candidates = boundary === -1 ? current : current.slice(0, boundary);
    const older = candidates.filter((row) => !freshIds.has(row.id) && row.status !== "local" && !row.finished);

    return {
        hasGap: boundary === -1 && older.length > 0,
        keepsCursor: hasLoadedOlder && older.length > 0,
        rows: [...older, ...fresh],
    };
};

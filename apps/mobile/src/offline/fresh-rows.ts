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

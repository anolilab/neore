/** The part of a message row the refresh merge reads. */
export interface FreshRow {
    createdAt: number;
    finished?: boolean;
    id: string;
    status: string;
}

/**
 * Replaces the newest rows with a fresh read. Rows older than the read's oldest row are kept only when older pages were
 * loaded on screen: the cursor on screen then continues after them. Otherwise the cursor comes from the fresh read, and
 * keeping them would show the same messages twice. A row created in the same millisecond as the oldest fresh row is
 * on the older side of the boundary, so it is kept too. Local rows are never kept: a fresh read holds their server
 * copies, or they are still being written.
 */
export const withFreshRows = <T extends FreshRow>(current: ReadonlyArray<T>, fresh: ReadonlyArray<T>, hasOlderPages: boolean): T[] => {
    if (!hasOlderPages) {
        return [...fresh];
    }

    const oldest = fresh[0]?.createdAt ?? 0;
    const freshIds = new Set(fresh.map((row) => row.id));
    const older = current.filter((row) => row.createdAt <= oldest && !freshIds.has(row.id) && row.status !== "local" && !row.finished);

    return [...older, ...fresh];
};

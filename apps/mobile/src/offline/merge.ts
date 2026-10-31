/** What decides which copy of a row is newer: the server's own stamp first, then when this device read it. */
export interface Versioned {
    id: string;
    syncedAt: number;
    updatedAt: number;
}

/** True when `candidate` is at least as new as `current`. An identical stamp qualifies, so saving a row twice is harmless. */
export const isAtLeastAsNew = (candidate: Versioned, current: Versioned): boolean =>
    candidate.updatedAt > current.updatedAt || (candidate.updatedAt === current.updatedAt && candidate.syncedAt >= current.syncedAt);

const isNewer = (candidate: Versioned, current: Versioned): boolean => isAtLeastAsNew(candidate, current) && !isAtLeastAsNew(current, candidate);

/**
 * Joins live rows with cached ones by id. The newer copy of a row wins, and live wins a tie, so a cached row
 * never overwrites newer live data. No row is ever dropped: the cache lacking a row does not mean it was deleted,
 * and neither does the live data lacking one.
 */
export const mergeRows = <T extends Versioned>(live: ReadonlyArray<T>, cached: ReadonlyArray<T>): T[] => {
    const merged: T[] = [];
    const positionById = new Map<string, number>();

    const consider = (candidate: T) => {
        const position = positionById.get(candidate.id);

        if (position === undefined) {
            positionById.set(candidate.id, merged.length);
            merged.push(candidate);
        } else if (isNewer(candidate, merged[position] as T)) {
            merged[position] = candidate;
        }
    };

    for (const candidate of live) {
        consider(candidate);
    }

    for (const candidate of cached) {
        consider(candidate);
    }

    return merged;
};

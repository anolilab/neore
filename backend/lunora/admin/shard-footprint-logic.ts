/**
 * Pure helpers for the shard footprint measurement in `admin/cleanup.ts`.
 *
 * A measurement reads a shard one page per call. Message rows are read in index order
 * (`by_threadId_order_stepOrder`), so one thread's rows are contiguous: the scan carries
 * the thread it is in and that thread's running row count, and keeps only the largest
 * threads it has finished. The state a call returns is bounded however large the shard.
 *
 * An admin call measures several shards at once, one page of each per round, and stops
 * when its call budget is spent. A shard that is not finished carries its state in the
 * census cursor, so the next call continues it.
 */

/** Rows per page: a call reads at most this many threads or message rows. */
export const FOOTPRINT_PAGE_SIZE = 500;
/** Threads kept in the largest list. */
export const LARGEST_THREAD_COUNT = 20;
/** Shards an admin call holds at once (carried over plus newly read from the census). */
export const SHARDS_PER_CALL = 10;
/**
 * Cross-shard calls one admin call may make. The Free-plan Worker allows 50 subrequests per
 * invocation; this leaves room for the census queries and anything else the action does.
 */
export const MAX_SHARD_CALLS_PER_ACTION = 40;

export interface LargestThread {
    rows: number;
    threadId: string;
}

export interface FootprintState {
    approxBytes: number;
    /** Rows of the thread the scan is in, not yet closed into `largest`. */
    currentRows: number;
    currentThreadId: string | null;
    cursor: string | null;
    largest: LargestThread[];
    messageRows: number;
    phase: "done" | "messages" | "threads";
    threads: number;
}

/** Consecutive failed reads after which a shard is given up for this census (its counts stay out). */
export const MAX_SHARD_FAILURES = 3;

/** A shard the census has handed out but that has not finished measuring, with its scan state. */
export interface PendingShard {
    /** Failed reads in a row since the shard last read successfully. */
    failures?: number;
    shardKey: string;
    state: FootprintState;
}

/** Whether a shard that has now failed `failures` times in a row is retried by a later call. */
export const willRetry = (failures: number): boolean => failures < MAX_SHARD_FAILURES;

/** Where an admin measurement is: the census position and the shards still being measured. */
export interface CensusCursor {
    /** The census's own cursor; `null` before the first page. */
    census: string | null;
    /** True once the census has been read to its end. */
    censusDone: boolean;
    pending: PendingShard[];
}

export const startFootprint = (): FootprintState => {
    return {
        approxBytes: 0,
        currentRows: 0,
        currentThreadId: null,
        cursor: null,
        largest: [],
        messageRows: 0,
        phase: "threads",
        threads: 0,
    };
};

/**
 * A scan state as an admin call's cursor carries it. The cursor reaches the browser, so the thread ids
 * in it (the largest list and the thread the scan is in) are dropped. The partial thread's rows still
 * count toward the totals; only its place in the largest list is lost.
 */
export const forCursor = (state: FootprintState): FootprintState => {
    return { ...state, currentRows: 0, currentThreadId: null, largest: [] };
};

export const startCensus = (): CensusCursor => {
    return { census: null, censusDone: false, pending: [] };
};

/**
 * The census for a collapsed (development, `SHARD_ROUTING=off`) stack: every shard key reaches
 * the same root shard, so the root is measured once and the user census is not read.
 */
export const rootOnlyCensus = (carried: CensusCursor, rootShardKey: string): CensusCursor => {
    if (carried.censusDone) {
        return carried;
    }

    return { census: null, censusDone: true, pending: [...carried.pending, { shardKey: rootShardKey, state: startFootprint() }] };
};

/**
 * The first call of a census also measures the root shard. Anonymous conversations (guest links, no
 * user shard) are written to the root shard, and no user row owns them, so the user walk misses them.
 */
export const withRootShard = (carried: CensusCursor, rootShardKey: string): CensusCursor => {
    if (carried.census !== null || carried.censusDone || carried.pending.some((entry) => entry.shardKey === rootShardKey)) {
        return carried;
    }

    return { ...carried, pending: [...carried.pending, { shardKey: rootShardKey, state: startFootprint() }] };
};

/**
 * The row's size in UTF-8 bytes, an estimate: its JSON encoding plus the bytes of each binary value in it.
 * A bigint is encoded as its decimal string, so a row holding one still measures instead of failing.
 */
export const approxRowBytes = (row: unknown): number => {
    let binaryBytes = 0;
    const json = JSON.stringify(row, (_key: string, value: unknown): unknown => {
        if (typeof value === "bigint") {
            return value.toString();
        }

        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            binaryBytes += value.byteLength;

            return null;
        }

        return value;
    });

    return new TextEncoder().encode(json).byteLength + binaryBytes;
};

/** Keeps the {@link LARGEST_THREAD_COUNT} entries with the most rows, largest first. */
export const keepLargest = (largest: LargestThread[], entry: LargestThread): LargestThread[] =>
    [...largest, entry].toSorted((a, b) => b.rows - a.rows || a.threadId.localeCompare(b.threadId)).slice(0, LARGEST_THREAD_COUNT);

/** Closes the thread the scan is in: it joins the largest list. */
export const finishCurrentThread = (state: FootprintState): FootprintState => {
    if (state.currentThreadId === null) {
        return state;
    }

    return {
        ...state,
        currentRows: 0,
        currentThreadId: null,
        largest: keepLargest(state.largest, { rows: state.currentRows, threadId: state.currentThreadId }),
    };
};

/** Adds one message row. Rows arrive grouped by thread, so a new thread id closes the previous one. */
export const addMessageRow = (state: FootprintState, threadId: string, bytes: number): FootprintState => {
    const base = state.currentThreadId === threadId ? state : finishCurrentThread(state);

    return {
        ...base,
        approxBytes: base.approxBytes + bytes,
        currentRows: base.currentRows + 1,
        currentThreadId: threadId,
        messageRows: base.messageRows + 1,
    };
};

/** One shard in a round-based scan: its state so far, and whether it is still being read. */
export interface ScanEntry {
    /** The error's name (for example `TypeError`) when the shard failed; the message is never kept. */
    errorName?: string;
    shardKey: string;
    state: FootprintState;
    status: "active" | "done" | "failed";
    /** True once any page of the shard has read successfully in this call. */
    succeeded?: boolean;
}

/**
 * Reads the active shards one page each per round, until none is active or `maxCalls` pages
 * have been read. A round that cannot fit every active shard reads the first ones in order.
 * A shard whose read throws is marked `failed` and is not read again in this call; its state stays at
 * the last page that succeeded, so the next call can retry it from there. Returns the calls made.
 */
export const runScanRounds = async (
    entries: ScanEntry[],
    readPage: (entry: ScanEntry) => Promise<{ done: boolean; state: FootprintState }>,
    maxCalls: number,
): Promise<number> => {
    let remaining = maxCalls;

    while (remaining > 0) {
        const active = entries.filter((entry) => entry.status === "active");

        if (active.length === 0) {
            break;
        }

        const round = active.slice(0, remaining);

        remaining -= round.length;

        await Promise.all(
            round.map(async (entry) => {
                try {
                    const result = await readPage(entry);

                    entry.state = result.state;
                    entry.succeeded = true;
                    entry.status = result.done ? "done" : "active";
                } catch (error) {
                    entry.errorName = error instanceof Error ? error.name : "unknown";
                    entry.status = "failed";
                }
            }),
        );
    }

    return maxCalls - remaining;
};

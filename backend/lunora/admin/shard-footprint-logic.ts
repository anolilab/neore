/**
 * Pure helpers for the shard footprint measurement (`shard-footprint.ts`).
 *
 * A measurement reads a shard one page per call. Message rows are read in index order
 * (`by_threadId_order_stepOrder`), so one thread's rows are contiguous: the scan carries
 * the thread it is in and that thread's running row count, and keeps only the largest
 * threads it has finished. The state a call returns is bounded however large the shard.
 */

/** Rows per page: a call reads at most this many threads or message rows. */
export const FOOTPRINT_PAGE_SIZE = 500;
/** Threads kept in the largest list. */
export const LARGEST_THREAD_COUNT = 20;

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

/** The row's JSON encoding in UTF-8 bytes. An estimate: the stored form is not JSON. */
export const approxRowBytes = (row: unknown): number => new TextEncoder().encode(JSON.stringify(row)).byteLength;

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

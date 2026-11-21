/**
 * Pure helpers for the shard footprint measurement in `admin/cleanup.ts`.
 *
 * A measurement reads a shard one page per call. Message rows are read in index order
 * (`by_threadId_order_stepOrder`), so one thread's rows are contiguous: the scan carries
 * the thread it is in and that thread's running row count, and keeps only the largest
 * threads it has finished. The state a call returns is bounded however large the shard.
 *
 * Each thread and each message row also counts in a breakdown by thread group (active, archived,
 * pinned, other) and age band (days since the thread's last activity), with tool results and large tool
 * results counted apart. The breakdown is sparse and has at most groups × bands entries.
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

/** Shard sizes an admin call reports, largest first, with no shard key. */
export const LARGEST_SHARD_COUNT = 10;
/**
 * The days since a thread's last activity at which each age band starts. The bands match the choices the retention plan
 * weighs: settle after 3, 7, 14 or 30 days, delete archived threads after 30, 90 or 365.
 */
export const AGE_BAND_START_DAYS = [0, 3, 7, 14, 30, 90, 365] as const;
/** A tool result of at least this many bytes counts as one that compacting old tool output would move to a file. */
export const LARGE_TOOL_ROW_BYTES = 64 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LargestThread {
    rows: number;
    threadId: string;
}

/**
 * Which rule a thread falls under: `pinned` is never deleted, `archived` is what a retention window would delete, `active`
 * is what settling would quiet, and `other` is trashed, temporary (already expiring), being deleted, or a message whose
 * thread is gone.
 */
export type ThreadGroup = "active" | "archived" | "other" | "pinned";

/** A thread's group and age band. */
export interface ThreadClass {
    group: ThreadGroup;
    /** The start of the thread's age band, one of {@link AGE_BAND_START_DAYS}. */
    sinceDays: number;
}

/**
 * The counts of one group and age band. Thread row bytes and message row bytes both count in `approxBytes`; `toolBytes`
 * and the large counts cover tool results only (`role: "tool"` rows), not the assistant rows that request a call.
 */
export interface BreakdownEntry extends ThreadClass {
    approxBytes: number;
    largeToolBytes: number;
    largeToolRows: number;
    messageRows: number;
    threads: number;
    toolBytes: number;
}

export interface FootprintState {
    approxBytes: number;
    /** Counts by group and age band. Sparse: a band with nothing in it has no entry. */
    breakdown: BreakdownEntry[];
    /** Row counts of the largest threads closed before the state last went into a cursor, ids dropped. */
    carriedLargestRows: number[];
    /** The class of the thread the scan is in, so its next rows need no second read of the thread. */
    currentClass: ThreadClass | null;
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
    /** The clock every page of this census classifies by, set by its first call, so a census never mixes age bands. */
    startedAt: number;
}

export const startFootprint = (): FootprintState => {
    return {
        approxBytes: 0,
        breakdown: [],
        carriedLargestRows: [],
        currentClass: null,
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
 * A scan state as an admin call's cursor carries it (sealed, see `encodeCensusCursor`). The thread the scan is in, its
 * class and its running count stay, so a thread split across admin calls is counted whole. The largest list is reduced
 * to its row counts (`carriedLargestRows`): only the numbers are ever reported, so its ids need not travel.
 */
export const forCursor = (state: FootprintState): FootprintState => {
    return { ...state, carriedLargestRows: largestRowsOf(state), largest: [] };
};

/** The row counts of the shard's largest threads so far, largest first: the carried ones and the current list. */
export const largestRowsOf = (state: FootprintState): number[] =>
    keepTop([...state.carriedLargestRows, ...state.largest.map((thread) => thread.rows)], LARGEST_THREAD_COUNT);

/** The thread fields a class is read from. */
export interface ClassifiedThread {
    _creationTime: number;
    createdAt?: number;
    deleted?: boolean;
    deletingAt?: number;
    isTemporary?: boolean;
    pinnedAt?: number;
    status: string;
    updatedAt?: number;
}

/** The start of the age band `days` falls in. */
export const ageBandStart = (days: number): number => {
    let start: number = AGE_BAND_START_DAYS[0];

    for (const bandStart of AGE_BAND_START_DAYS) {
        if (days >= bandStart) {
            start = bandStart;
        }
    }

    return start;
};

/**
 * A thread's group and age band at `now`. Its age is the days since `updatedAt`, which moves on every activity and on
 * archiving itself, so for an archived thread it is the time since it was archived (no thread stores an archive time).
 * A row from before `updatedAt` existed falls back to its creation time. A running thread is active now, so it is in the
 * first band whatever its `updatedAt`. A missing thread (`null`) is `other`.
 */
export const classifyThread = (thread: ClassifiedThread | null, now: number): ThreadClass => {
    if (thread === null) {
        return { group: "other", sinceDays: 0 };
    }

    const lastActivity = thread.status === "running" ? now : (thread.updatedAt ?? thread.createdAt ?? thread._creationTime);
    const sinceDays = ageBandStart(Math.max(0, Math.floor((now - lastActivity) / DAY_MS)));

    if (thread.deleted === true || thread.isTemporary === true || thread.deletingAt !== undefined) {
        return { group: "other", sinceDays };
    }

    if (thread.pinnedAt !== undefined) {
        return { group: "pinned", sinceDays };
    }

    return { group: thread.status === "archived" ? "archived" : "active", sinceDays };
};

type BreakdownCounts = Omit<BreakdownEntry, keyof ThreadClass>;

const NO_COUNTS: BreakdownCounts = { approxBytes: 0, largeToolBytes: 0, largeToolRows: 0, messageRows: 0, threads: 0, toolBytes: 0 };

/** `breakdown` with `counts` added to the entry of `threadClass`, which is created when it has none yet. */
export const addToBreakdown = (breakdown: BreakdownEntry[], threadClass: ThreadClass, counts: Partial<BreakdownCounts>): BreakdownEntry[] => {
    const index = breakdown.findIndex((entry) => entry.group === threadClass.group && entry.sinceDays === threadClass.sinceDays);
    const current: BreakdownEntry = index === -1 ? { ...NO_COUNTS, ...threadClass } : (breakdown[index] as BreakdownEntry);
    const next: BreakdownEntry = { ...current };

    for (const key of Object.keys(NO_COUNTS) as (keyof BreakdownCounts)[]) {
        next[key] += counts[key] ?? 0;
    }

    return index === -1 ? [...breakdown, next] : breakdown.map((entry, position) => (position === index ? next : entry));
};

/** Two breakdowns summed entry by entry, in a stable order (group, then age band). */
export const mergeBreakdowns = (first: BreakdownEntry[], second: BreakdownEntry[]): BreakdownEntry[] => {
    let merged = first;

    for (const entry of second) {
        const { group, sinceDays, ...counts } = entry;

        merged = addToBreakdown(merged, { group, sinceDays }, counts);
    }

    return merged.toSorted((a, b) => a.group.localeCompare(b.group) || a.sinceDays - b.sinceDays);
};

/** The `count` largest of `values`, largest first. */
export const keepTop = (values: number[], count: number): number[] => values.toSorted((a, b) => b - a).slice(0, count);

/** A new census that classifies every thread at `now`. */
export const startCensus = (now: number): CensusCursor => {
    return { census: null, censusDone: false, pending: [], startedAt: now };
};

/**
 * The census for a collapsed (development, `SHARD_ROUTING=off`) stack: every shard key reaches
 * the same root shard, so the root is measured once and the user census is not read.
 */
export const rootOnlyCensus = (carried: CensusCursor, rootShardKey: string): CensusCursor => {
    if (carried.censusDone) {
        return carried;
    }

    return { ...carried, census: null, censusDone: true, pending: [...carried.pending, { shardKey: rootShardKey, state: startFootprint() }] };
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
        currentClass: null,
        currentRows: 0,
        currentThreadId: null,
        largest: keepLargest(state.largest, { rows: state.currentRows, threadId: state.currentThreadId }),
    };
};

/** Adds one thread row: one thread and its row's bytes, in its group and age band. */
export const addThreadRow = (state: FootprintState, threadClass: ThreadClass, bytes: number): FootprintState => {
    return {
        ...state,
        approxBytes: state.approxBytes + bytes,
        breakdown: addToBreakdown(state.breakdown, threadClass, { approxBytes: bytes, threads: 1 }),
        threads: state.threads + 1,
    };
};

/** One message row as the scan sees it. */
export interface MessageRowInput {
    bytes: number;
    /** The class of the row's thread. */
    threadClass: ThreadClass;
    threadId: string;
    /** True for a tool result (`role: "tool"`). An assistant row that requests a call is not one. */
    toolOutput: boolean;
}

/** Adds one message row. Rows arrive grouped by thread, so a new thread id closes the previous one. */
export const addMessageRow = (state: FootprintState, row: MessageRowInput): FootprintState => {
    const base = state.currentThreadId === row.threadId ? state : finishCurrentThread(state);
    const large = row.toolOutput && row.bytes >= LARGE_TOOL_ROW_BYTES;

    return {
        ...base,
        approxBytes: base.approxBytes + row.bytes,
        breakdown: addToBreakdown(base.breakdown, row.threadClass, {
            approxBytes: row.bytes,
            largeToolBytes: large ? row.bytes : 0,
            largeToolRows: large ? 1 : 0,
            messageRows: 1,
            toolBytes: row.toolOutput ? row.bytes : 0,
        }),
        currentClass: row.threadClass,
        currentRows: base.currentRows + 1,
        currentThreadId: row.threadId,
        messageRows: base.messageRows + 1,
    };
};

/** The class to use for a message row: the current thread's when the row continues it, else `undefined` (read the thread). */
export const knownClassFor = (state: FootprintState, threadId: string): ThreadClass | undefined =>
    state.currentThreadId === threadId && state.currentClass !== null ? state.currentClass : undefined;

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

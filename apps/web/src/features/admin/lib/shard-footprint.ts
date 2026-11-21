/**
 * The admin shard footprint's pages summed, and the readings the conversation-retention plan's decisions need: archived
 * threads by how long they have been archived, active threads by how long they have been idle, and how much of the stored
 * size is tool output. The breakdown comes from `admin.cleanup.getShardFootprint`; no thread id or shard key is in it.
 */

export type ThreadGroup = "active" | "archived" | "other" | "pinned";

export interface BreakdownEntry {
    approxBytes: number;
    group: ThreadGroup;
    largeToolBytes: number;
    largeToolRows: number;
    messageRows: number;
    /** The start of the age band: days since the thread's last activity (for an archived thread, since it was archived). */
    sinceDays: number;
    threads: number;
    toolBytes: number;
}

export interface FootprintTotals {
    /** Shards given up for this census: their counts are not in the totals. Each is reported once, so pages add up. */
    abandonedShards: number;
    approxBytes: number;
    breakdown: BreakdownEntry[];
    largestShardBytes: number[];
    largestThreadRows: number[];
    messageRows: number;
    shards: number;
    threads: number;
}

/** Days archived at which the retention plan weighs deleting (0 is every archived thread). */
export const ARCHIVED_SINCE_DAYS = [0, 30, 90, 365] as const;
/** Idle days the settle setting offers. */
export const IDLE_SINCE_DAYS = [3, 7, 14, 30] as const;
/** Idle days after which old tool output is counted as compactable. */
export const COMPACT_AFTER_DAYS = 30;
/** Numbers kept in each "largest" list, as the backend keeps them. */
const LARGEST_THREADS = 20;
const LARGEST_SHARDS = 10;

export const NO_TOTALS: FootprintTotals = {
    abandonedShards: 0,
    approxBytes: 0,
    breakdown: [],
    largestShardBytes: [],
    largestThreadRows: [],
    messageRows: 0,
    shards: 0,
    threads: 0,
};

const keepTop = (values: number[], count: number): number[] => values.toSorted((a, b) => b - a).slice(0, count);

const COUNT_KEYS = ["approxBytes", "largeToolBytes", "largeToolRows", "messageRows", "threads", "toolBytes"] as const;

/** Two breakdowns summed by group and age band. */
const mergeBreakdowns = (first: BreakdownEntry[], second: BreakdownEntry[]): BreakdownEntry[] => {
    const merged = first.map((entry) => {
        return { ...entry };
    });

    for (const entry of second) {
        const existing = merged.find((candidate) => candidate.group === entry.group && candidate.sinceDays === entry.sinceDays);

        if (existing === undefined) {
            merged.push({ ...entry });
        } else {
            for (const key of COUNT_KEYS) {
                existing[key] += entry[key];
            }
        }
    }

    return merged;
};

/** The measured pages summed: counts add up, and the largest lists keep their largest numbers. */
export const sumTotals = (pages: FootprintTotals[]): FootprintTotals => {
    let sum = NO_TOTALS;

    for (const page of pages) {
        sum = {
            abandonedShards: sum.abandonedShards + page.abandonedShards,
            approxBytes: sum.approxBytes + page.approxBytes,
            breakdown: mergeBreakdowns(sum.breakdown, page.breakdown),
            largestShardBytes: keepTop([...sum.largestShardBytes, ...page.largestShardBytes], LARGEST_SHARDS),
            largestThreadRows: keepTop([...sum.largestThreadRows, ...page.largestThreadRows], LARGEST_THREADS),
            messageRows: sum.messageRows + page.messageRows,
            shards: sum.shards + page.shards,
            threads: sum.threads + page.threads,
        };
    }

    return sum;
};

export interface GroupCounts {
    approxBytes: number;
    largeToolBytes: number;
    largeToolRows: number;
    messageRows: number;
    threads: number;
    toolBytes: number;
}

/** The counts of the entries in `groups` whose age band starts at `minDays` or later. */
export const countsSince = (breakdown: BreakdownEntry[], groups: ThreadGroup[], minDays: number): GroupCounts => {
    const sum: GroupCounts = { approxBytes: 0, largeToolBytes: 0, largeToolRows: 0, messageRows: 0, threads: 0, toolBytes: 0 };

    for (const entry of breakdown) {
        if (groups.includes(entry.group) && entry.sinceDays >= minDays) {
            for (const key of COUNT_KEYS) {
                sum[key] += entry[key];
            }
        }
    }

    return sum;
};

export interface FootprintReadings {
    /** Archived threads, not pinned, archived at least `sinceDays` ago: what a retention window would delete. */
    archived: (GroupCounts & { sinceDays: number })[];
    /** Tool rows in threads idle at least {@link COMPACT_AFTER_DAYS} days: what compacting old tool output would act on. */
    compactable: GroupCounts;
    /** Active threads idle at least `sinceDays`: what settling would quiet. */
    idle: (GroupCounts & { sinceDays: number })[];
    /** Every group except `other`: the threads a retention window or compaction would act on, or keep. */
    kept: GroupCounts;
    other: GroupCounts;
    pinned: GroupCounts;
}

export const readingsOf = (breakdown: BreakdownEntry[]): FootprintReadings => {
    return {
        archived: ARCHIVED_SINCE_DAYS.map((sinceDays) => {
            return { ...countsSince(breakdown, ["archived"], sinceDays), sinceDays };
        }),
        compactable: countsSince(breakdown, ["active", "archived", "pinned"], COMPACT_AFTER_DAYS),
        idle: IDLE_SINCE_DAYS.map((sinceDays) => {
            return { ...countsSince(breakdown, ["active"], sinceDays), sinceDays };
        }),
        kept: countsSince(breakdown, ["active", "archived", "pinned"], 0),
        other: countsSince(breakdown, ["other"], 0),
        pinned: countsSince(breakdown, ["pinned"], 0),
    };
};

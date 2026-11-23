/**
 * `events/poll` over one user's event log, as a pure function of a store. The store is the shard's `mcpEvents` rows in
 * production (`events.ts`) and an array in the tests.
 *
 * Positions are `seq` values. `fromSeq` is the seq the client's cursor names (the last event it has), or `null` for "start
 * from now". The answer's `nextSeq` is the last position the poll examined, so a client resumes there even when nothing
 * matched.
 */
/** Rows read from the store per round trip while a poll scans for matches. */
const PAGE = 100;

/** Rows one poll may examine. Past it the poll stops, reports `hasMore`, and the client continues from `nextSeq`. */
export const POLL_SCAN_LIMIT = 1000;

export interface StoredEvent {
    data: Record<string, unknown>;
    eventId: string;
    name: string;
    seq: number;
    timestamp: number;
}

export interface EventLogStore {
    /** Up to `limit` events with `seq` greater than `afterSeq`, in seq order. */
    after: (afterSeq: number, limit: number) => Promise<StoredEvent[]>;
    /** The highest seq written, `0` for an empty log. */
    latestSeq: () => Promise<number>;
    /** The lowest seq still kept, or `undefined` for an empty log. */
    oldestSeq: () => Promise<number | undefined>;
}

export interface PollQuery {
    fromSeq: number | null;
    maxAgeMs?: number;
    maxEvents: number;
    name: string;
    /** When the poll runs, in epoch milliseconds. */
    now: number;
    threadId?: string;
}

export interface PollOutcome {
    events: { data: Record<string, unknown>; eventId: string; name: string; timestamp: number }[];
    hasMore: boolean;
    /** The position to resume from: the last seq examined, or the oldest-available position after a truncation. */
    nextSeq: number;
    truncated: boolean;
}

const matches = (event: StoredEvent, query: PollQuery): boolean =>
    event.name === query.name && (query.threadId === undefined || event.data["threadId"] === query.threadId);

export const pollEvents = async (store: EventLogStore, query: PollQuery): Promise<PollOutcome> => {
    if (query.fromSeq === null) {
        // "Start from now": nothing is replayed, and the cursor is the log's current end.
        return { events: [], hasMore: false, nextSeq: await store.latestSeq(), truncated: false };
    }

    let from = query.fromSeq;
    let truncated = false;

    // A cursor older than the kept window: resume from the oldest position still held, and say events were skipped.
    const oldest = await store.oldestSeq();

    if (oldest !== undefined && from + 1 < oldest) {
        from = oldest - 1;
        truncated = true;
    }

    const floor = query.maxAgeMs === undefined ? undefined : query.now - query.maxAgeMs;
    const events: PollOutcome["events"] = [];
    let scanned = 0;
    let hasMore = false;

    let stopped = false;

    while (!stopped) {
        const page = await store.after(from, PAGE);

        if (page.length === 0) {
            break;
        }

        for (const event of page) {
            // Every row examined counts, matched or not, so a log of non-matching rows cannot keep one poll scanning.
            if (scanned >= POLL_SCAN_LIMIT) {
                hasMore = true;
                stopped = true;
                break;
            }

            scanned += 1;

            if (floor !== undefined && event.timestamp < floor) {
                // Older than the window the caller asked for: skipped, and that is a gap.
                truncated = true;
                from = event.seq;
                continue;
            }

            if (matches(event, query)) {
                if (events.length === query.maxEvents) {
                    // The cap is reached and one more match exists: the cursor stays before it.
                    hasMore = true;
                    stopped = true;
                    break;
                }

                events.push({ data: event.data, eventId: event.eventId, name: event.name, timestamp: event.timestamp });
            }

            from = event.seq;
        }
    }

    return { events, hasMore, nextSeq: from, truncated };
};

/**
 * `events/poll` over one user's event log, as a pure function of a store. The store is the shard's `mcpEvents` rows in
 * production (`events.ts`) and an array in the tests.
 *
 * Positions are `seq` values. `fromSeq` is the seq the client's cursor names (the last event it has), or `null` for "start
 * from now". The answer's `nextSeq` is the last position the poll examined, so a client resumes there even when nothing
 * matched.
 */
/**
 * Rows read from the store per round trip while a poll scans for matches. Small, because a row's payload is not size-capped when
 * recorded: a page of large rows is held at once.
 */
const PAGE = 25;

/** Rows one poll may examine. Past it the poll stops, reports `hasMore`, and the client continues from `nextSeq`. */
export const POLL_SCAN_LIMIT = 1000;

/**
 * The bytes of event payloads one poll answers with, so the answer stays well inside the internal call's size limit. A poll cuts
 * before the event that would pass it and reports `hasMore`; it always gives at least one event, so it cannot stall on a large one.
 */
export const POLL_BYTE_BUDGET = 512 * 1024;

/**
 * The bytes of event payloads one poll may read from the store, whether or not the event matches. It sits well inside the
 * transaction's read budget, so a log of large payloads cannot fail a poll for unrelated events.
 */
export const POLL_READ_BUDGET = 8 * 1024 * 1024;

const encoder = new TextEncoder();

export interface StoredEvent {
    /** When the log took the event (its insertion or copy time): the clock retention and the age window run on. */
    createdAt: number;
    data: Record<string, unknown>;
    eventId: string;
    name: string;
    seq: number;
    /** When the event itself happened (upstream). Reported as recorded; it does not decide what the window keeps. */
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
    /** Whether an event is kept from the caller: the shard's locked threads' events are (their metadata is not for a poll). Skipped, not a gap. */
    hidden?: (event: StoredEvent) => Promise<boolean>;
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
    // A poll allowed to return nothing could stop before it moves the cursor, and the client would ask again from the same place.
    // The MCP boundary already refuses this; the core refuses it too, so it cannot be reached another way.
    if (!Number.isSafeInteger(query.maxEvents) || query.maxEvents < 1) {
        throw new RangeError("maxEvents must be an integer of at least 1");
    }

    // A negative age puts the window's floor after `now`: every event reads as older, so the poll would skip them all and move the cursor past them.
    if (query.maxAgeMs !== undefined && (!Number.isFinite(query.maxAgeMs) || query.maxAgeMs < 0)) {
        throw new RangeError("maxAgeMs must be a finite number of at least 0");
    }

    if (query.fromSeq === null) {
        // "Start from now": nothing is replayed, and the cursor is the log's current end.
        return { events: [], hasMore: false, nextSeq: await store.latestSeq(), truncated: false };
    }

    let from = query.fromSeq;
    let truncated = false;

    // A cursor older than the kept window: resume from the oldest position still held, and say events were skipped. An empty
    // log holds nothing, so its oldest position is the one after its end: a cursor behind that has been skipped past.
    const oldest = (await store.oldestSeq()) ?? (await store.latestSeq()) + 1;

    if (from + 1 < oldest) {
        from = oldest - 1;
        truncated = true;
    }

    const floor = query.maxAgeMs === undefined ? undefined : query.now - query.maxAgeMs;
    const events: PollOutcome["events"] = [];
    let scanned = 0;
    let bytes = 0;
    let readBytes = 0;
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

            // The bytes a poll reads are bounded as well: a payload is not size-capped when recorded, so a scan of large rows stops
            // within the transaction's read budget, and the client continues from the last row read (`nextSeq`). A poll always reads
            // at least one row, so a single large row cannot stall it.
            const rowBytes = encoder.encode(JSON.stringify(event.data)).byteLength;

            if (readBytes > 0 && readBytes + rowBytes > POLL_READ_BUDGET) {
                hasMore = true;
                stopped = true;
                break;
            }

            readBytes += rowBytes;
            scanned += 1;

            // The window is on `createdAt`, the same clock retention deletes by: an event recorded late (its upstream time long past) is
            // still kept for a window from when the log took it, so a poll must not skip it as old.
            if (floor !== undefined && event.createdAt < floor) {
                // Older than the window the caller asked for. A gap only when it is an event the caller asked for and may see: another
                // name or thread in that window was never the caller's to receive, and a hidden (locked-thread) event must not reveal
                // itself by flagging a gap.
                if (matches(event, query) && (query.hidden === undefined || !(await query.hidden(event)))) {
                    truncated = true;
                }

                from = event.seq;
                continue;
            }

            // A hidden event is passed over as the window's old events are, and it is no gap: the caller was never meant to see it.
            // Only a row the caller asked for is looked up: another name or thread is passed over without a lookup.
            if (matches(event, query) && query.hidden !== undefined && (await query.hidden(event))) {
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

                const size = encoder.encode(JSON.stringify(event.data)).byteLength;

                if (events.length > 0 && bytes + size > POLL_BYTE_BUDGET) {
                    // The byte budget is full: the cursor stays before this event, which the next poll answers first.
                    hasMore = true;
                    stopped = true;
                    break;
                }

                bytes += size;
                events.push({ data: event.data, eventId: event.eventId, name: event.name, timestamp: event.timestamp });
            }

            from = event.seq;
        }
    }

    return { events, hasMore, nextSeq: from, truncated };
};

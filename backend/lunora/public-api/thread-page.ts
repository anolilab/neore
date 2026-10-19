/**
 * One page of the public thread list without the locked chats. A locked chat is
 * removed after the page is read, so a run of them could leave a short or empty
 * page that still carries a next cursor; clients that stop on an empty page would
 * miss everything after it. This keeps reading, asking for only the shortfall so
 * the page never exceeds `limit` and the cursor always follows the last row read.
 */
import { isThreadLocked } from "../lib/thread-lock";

/** Reads past locked chats this many times, then returns what it has with a valid cursor. */
const MAX_FETCHES = 5;

interface ThreadPage<T> {
    continueCursor: string | null;
    isDone: boolean;
    page: T[];
}

export const collectUnlockedThreads = async <T extends { lockedAt?: number | null }, Cursor>(
    fetchPage: (cursor: Cursor, numberItems: number) => Promise<ThreadPage<T>>,
    startCursor: Cursor,
    limit: number,
): Promise<{ continueCursor: string | null; isDone: boolean; threads: T[] }> => {
    const threads: T[] = [];
    let cursor = startCursor;
    let continueCursor: string | null = null;
    let isDone = false;

    for (let fetches = 0; fetches < MAX_FETCHES; fetches += 1) {
        const result = await fetchPage(cursor, limit - threads.length);

        threads.push(...result.page.filter((thread) => !isThreadLocked(thread)));
        continueCursor = result.continueCursor;
        isDone = result.isDone;

        if (isDone || threads.length >= limit) {
            break;
        }

        cursor = result.continueCursor as Cursor;
    }

    return { continueCursor, isDone, threads };
};

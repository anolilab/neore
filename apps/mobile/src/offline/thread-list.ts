import type { ScopedCache } from "./cache";
import { isNetworkFailure } from "./connectivity";
import { settleQuietly } from "./quietly";
import type { ThreadRow } from "./types";

export const OFFLINE_EMPTY_NOTICE = "You are offline and nothing is saved on this device yet.";

export interface ThreadPage {
    continueCursor: string | null;
    isDone: boolean;
    /** Locked threads are listed as stubs: their title is content, so they are never saved. */
    lockedIds: ReadonlySet<string>;
    rows: ThreadRow[];
}

export type LiveThreadListRead
    = { kind: "failed"; message: string } | { kind: "page"; page: ThreadPage; startedAt: number } | { kind: "unreachable" };

/** The saved list. An unreadable cache is an empty one. */
export const loadCachedThreads = async (cache: ScopedCache | undefined): Promise<ThreadRow[]> => {
    try {
        return await cache?.loadThreads() ?? [];
    } catch {
        return [];
    }
};

/**
 * Saves one live page, stamped with the moment its read began. A locked thread is forgotten instead. Only a page
 * that is the whole list (the first page, and the end of it) may prune: a thread missing from a partial page proves
 * nothing, but one missing from the complete list is gone from the server.
 */
export const persistThreadPage = (cache: ScopedCache | undefined, page: ThreadPage, { isComplete, startedAt }: { isComplete: boolean; startedAt: number }): void => {
    settleQuietly(cache?.saveThreads(page.rows.filter((thread) => !page.lockedIds.has(thread.id)), { syncedAt: startedAt }));
    settleQuietly(cache?.forgetThreads([...page.lockedIds]));

    if (isComplete) {
        settleQuietly(cache?.pruneThreads(page.rows.map((thread) => thread.id), { readStartedAt: startedAt }));
    }
};

/**
 * The first live page, saved on success. A failure is handed back as a value and touches nothing: the rows already
 * on screen and in the cache stay, and the next read (a reconnect) simply tries again.
 */
export const readLiveThreadList = async ({
    cache,
    fetchFirstPage,
    now = Date.now,
}: {
    cache: ScopedCache | undefined;
    fetchFirstPage: (startedAt: number) => Promise<ThreadPage>;
    now?: () => number;
}): Promise<LiveThreadListRead> => {
    const startedAt = now();

    try {
        const page = await fetchFirstPage(startedAt);

        persistThreadPage(cache, page, { isComplete: page.isDone, startedAt });

        return { kind: "page", page, startedAt };
    } catch (error: unknown) {
        if (isNetworkFailure(error)) {
            return { kind: "unreachable" };
        }

        return { kind: "failed", message: error instanceof Error ? error.message : "Could not load chats." };
    }
};

/**
 * What to say above the list, or nothing. It is worked out from the current state each render, so it ends with the
 * outage that caused it and never sticks after a reconnect.
 */
export const listNotice = ({
    cacheChecked,
    isOffline,
    loadError,
    rowCount,
}: {
    cacheChecked: boolean;
    isOffline: boolean;
    loadError: string | undefined;
    rowCount: number;
}): string | undefined => {
    if (loadError !== undefined) {
        return loadError;
    }

    return isOffline && cacheChecked && rowCount === 0 ? OFFLINE_EMPTY_NOTICE : undefined;
};

/**
 * Pure helpers for user-defined thread tags: filtering, lookup and the
 * optimistic cache patch. Kept free of React so they are unit-testable.
 */

import type { ThreadTagColor } from "@neore/backend/chat/tags";

// Palette and limits are owned by the backend module the mutations validate with.
export { THREAD_TAG_COLORS, THREAD_TAG_NAME_MAX_LENGTH, type ThreadTagColor } from "@neore/backend/chat/tags";

export interface ThreadTag {
    _id: string;
    color: ThreadTagColor;
    name: string;
    order: number;
}

export interface ThreadListFilters {
    /** AI-assigned category, or `undefined` for all. */
    category?: string;
    /** User tag ids; a thread matches when it carries ANY of them. Empty means no tag filter. */
    tagIds: ReadonlyArray<string>;
}

/**
 * Whether a thread passes the list filters. Category and tag filters combine
 * with AND; selected tags combine with OR.
 */
export const matchesThreadFilters = (thread: { category?: string; tagIds?: ReadonlyArray<string> }, filters: ThreadListFilters): boolean => {
    if (filters.category && thread.category !== filters.category) {
        return false;
    }

    if (filters.tagIds.length === 0) {
        return true;
    }

    const threadTagIds = thread.tagIds ?? [];

    return filters.tagIds.some((tagId) => threadTagIds.includes(tagId));
};

/**
 * Drops selected tag ids that no longer exist (deleted, possibly on another
 * device), so a stale selection cannot silently hide every thread. Returns the
 * input array itself when nothing changed, to keep memo dependencies stable.
 */
export const pruneSelectedTagIds = (selected: ReadonlyArray<string>, tags: ReadonlyArray<ThreadTag> | undefined): ReadonlyArray<string> => {
    if (selected.length === 0 || tags === undefined) {
        return selected;
    }

    const known = new Set(tags.map((tag) => tag._id));
    const pruned = selected.filter((id) => known.has(id));

    return pruned.length === selected.length ? selected : pruned;
};

/** Resolves a thread's tag ids to tags in the user's display order, skipping unknown ids. */
export const resolveThreadTags = (tagIds: ReadonlyArray<string> | undefined, tags: ReadonlyArray<ThreadTag> | undefined): ThreadTag[] => {
    if (!tagIds?.length || !tags?.length) {
        return [];
    }

    const wanted = new Set(tagIds);

    return tags.filter((tag) => wanted.has(tag._id)).toSorted((a, b) => a.order - b.order);
};

/** Toggles `id` in a selection, preserving order. */
export const toggleSelectedTagId = (selected: ReadonlyArray<string>, id: string): string[] =>
    selected.includes(id) ? selected.filter((candidate) => candidate !== id) : [...selected, id];

/** Swaps the tag at `index` with its neighbour in `direction`; returns ids in the new order, or `undefined` at an edge. */
export const moveTag = (tags: ReadonlyArray<ThreadTag>, index: number, direction: -1 | 1): string[] | undefined => {
    const target = index + direction;

    if (index < 0 || index >= tags.length || target < 0 || target >= tags.length) {
        return undefined;
    }

    const ids = tags.map((tag) => tag._id);
    const moved = ids[index]!;

    ids[index] = ids[target]!;
    ids[target] = moved;

    return ids;
};

interface ThreadLike {
    _id: string;
    tagIds?: string[];
}

interface ThreadListDataLike<T extends ThreadLike> {
    pinnedThreads: T[];
    temporaryThreads: { page: T[] };
    threadOrders: T[];
    threads: { page: T[] };
}

/**
 * Returns a copy of the cached `getThreadListData` result with one thread's
 * `tagIds` replaced everywhere that thread appears. Untouched arrays keep their
 * identity.
 */
export const withThreadTagIds = <T extends ThreadLike, D extends ThreadListDataLike<T>>(data: D, threadId: string, tagIds: string[]): D => {
    const patch = (list: T[]): T[] =>
        list.some((thread) => thread._id === threadId) ? list.map((thread) => (thread._id === threadId ? { ...thread, tagIds } : thread)) : list;

    return {
        ...data,
        pinnedThreads: patch(data.pinnedThreads),
        temporaryThreads: { ...data.temporaryThreads, page: patch(data.temporaryThreads.page) },
        threadOrders: patch(data.threadOrders),
        threads: { ...data.threads, page: patch(data.threads.page) },
    };
};

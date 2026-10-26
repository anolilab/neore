/**
 * A per-user copy of the sidebar's thread list in `localStorage`, read
 * synchronously so a reload paints the list before the first query answers.
 *
 * It is only ever a placeholder: the caller hands it to the query as
 * `placeholderData`, so it never enters the query cache and the live result
 * replaces it. What is stored is a field-by-field projection of what the sidebar
 * draws — never a spread of the thread document, which carries a share token, the
 * custom system prompt and a summary — and no messages, so no `storage:` ref ever
 * needs signing here. Every storage access is guarded: a disabled, full or
 * corrupt store reads as "no cache".
 */

const CACHE_PREFIX = "neore-thread-list:";
const CACHE_VERSION = 1;

const clears = { count: 0 };

/** Bumped by every clear; a write scheduled before a clear compares it to drop itself. */
export const getThreadListClearGeneration = (): number => clears.count;

/** Keyed by the signed-in user, so one account's list is never read for another. */
const cacheKey = (userId: string): string => `${CACHE_PREFIX}v${CACHE_VERSION}:${userId}`;

type Primitive = boolean | number | string;
type PersistedRecord = Record<string, Primitive | string[]>;

export interface PersistedThreadList {
    pinnedThreads: PersistedRecord[];
    relationships: PersistedRecord[];
    tags: PersistedRecord[];
    temporaryThreads: PersistedRecord[];
    threadOrders: PersistedRecord[];
    threads: PersistedRecord[];
}

const THREAD_FIELDS = [
    "_creationTime",
    "_id",
    "category",
    "createdAt",
    "expiresAt",
    "lockedAt",
    "model",
    "projectId",
    "source",
    "statelessMode",
    "status",
    "tagIds",
    "title",
    "updatedAt",
] as const;
const PIN_FIELDS = ["_id"] as const;
const ORDER_FIELDS = ["_id", "order"] as const;
const RELATIONSHIP_FIELDS = ["branchPoint", "branchType", "createdAt", "parentThreadId", "threadId"] as const;
const TAG_FIELDS = ["_id", "color", "name", "order"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isPrimitive = (value: unknown): value is Primitive => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** A NEW object holding only the listed fields that carry a plain value. */
const pick = (source: unknown, fields: ReadonlyArray<string>): PersistedRecord | undefined => {
    if (!isRecord(source)) {
        return undefined;
    }

    const picked: PersistedRecord = {};

    for (const field of fields) {
        const value = source[field];

        if (isPrimitive(value) || isStringArray(value)) {
            picked[field] = value;
        }
    }

    return picked;
};

const pickAll = (source: unknown, fields: ReadonlyArray<string>): PersistedRecord[] =>
    Array.isArray(source) ? source.map((item) => pick(item, fields)).filter((record) => record !== undefined) : [];

/** Whether a thread row names a different owner than `userId` (an anonymous row names none). */
const isForeignRow = (row: unknown, userId: string): boolean => isRecord(row) && typeof row.userId === "string" && row.userId !== userId;

/** The sidebar's slice of a `getThreadListData` result, or `undefined` when it is not one or holds another user's rows. */
export const projectThreadList = (data: unknown, userId: string): PersistedThreadList | undefined => {
    if (!isRecord(data) || !isRecord(data.threads) || !Array.isArray(data.threads.page)) {
        return undefined;
    }

    const temporaryPage = isRecord(data.temporaryThreads) ? data.temporaryThreads.page : undefined;

    if ([...data.threads.page, ...(Array.isArray(temporaryPage) ? temporaryPage : [])].some((row) => isForeignRow(row, userId))) {
        return undefined;
    }

    return {
        pinnedThreads: pickAll(data.pinnedThreads, PIN_FIELDS),
        relationships: pickAll(data.relationships, RELATIONSHIP_FIELDS),
        tags: pickAll(data.tags, TAG_FIELDS),
        temporaryThreads: pickAll(temporaryPage, THREAD_FIELDS),
        threadOrders: pickAll(data.threadOrders, ORDER_FIELDS),
        threads: pickAll(data.threads.page, THREAD_FIELDS),
    };
};

/** The query-result shape the sidebar reads, rebuilt from a stored projection. */
export const toThreadListData = (persisted: PersistedThreadList) => {
    return {
        pinnedThreads: persisted.pinnedThreads,
        relationships: persisted.relationships,
        tags: persisted.tags,
        temporaryThreads: { continueCursor: "", isDone: true, page: persisted.temporaryThreads },
        threadOrders: persisted.threadOrders,
        threads: { continueCursor: "", isDone: true, page: persisted.threads },
    };
};

/** The browser's `localStorage`, or `undefined` on the server or when the browser denies access to it. */
export const getThreadListStorage = (): Storage | undefined => {
    try {
        return globalThis.localStorage ?? undefined;
    } catch {
        return undefined;
    }
};

const FIELD_TYPES: Record<string, (value: unknown) => boolean> = {
    _creationTime: (value) => typeof value === "number",
    _id: (value) => typeof value === "string",
    branchPoint: (value) => typeof value === "number",
    branchType: (value) => typeof value === "string",
    category: (value) => typeof value === "string",
    color: (value) => typeof value === "string",
    createdAt: (value) => typeof value === "number",
    expiresAt: (value) => typeof value === "number",
    lockedAt: (value) => typeof value === "number",
    model: (value) => typeof value === "string",
    name: (value) => typeof value === "string",
    order: (value) => typeof value === "number",
    parentThreadId: (value) => typeof value === "string",
    projectId: (value) => typeof value === "string",
    source: (value) => typeof value === "string",
    statelessMode: (value) => typeof value === "boolean",
    status: (value) => typeof value === "string",
    tagIds: isStringArray,
    threadId: (value) => typeof value === "string",
    title: (value) => typeof value === "string",
    updatedAt: (value) => typeof value === "number",
};

const REQUIRED_FIELDS: Record<keyof PersistedThreadList, ReadonlyArray<string>> = {
    pinnedThreads: ["_id"],
    relationships: ["parentThreadId", "threadId"],
    tags: ["_id"],
    temporaryThreads: ["_id"],
    threadOrders: ["_id"],
    threads: ["_id"],
};

/** A stored row is only trusted when it holds its identifying fields and every field has the type the sidebar reads. */
const isPersistedRow = (row: unknown, required: ReadonlyArray<string>): boolean =>
    isRecord(row) && required.every((field) => row[field] !== undefined) && Object.entries(row).every(([field, value]) => FIELD_TYPES[field]?.(value) === true);

const isPersistedList = (value: unknown): value is PersistedThreadList =>
    isRecord(value) &&
    (Object.keys(REQUIRED_FIELDS) as (keyof PersistedThreadList)[]).every((name) => {
        const rows = value[name];

        return Array.isArray(rows) && rows.every((row) => isPersistedRow(row, REQUIRED_FIELDS[name]));
    });

/**
 * The stored list for `userId`. A missing user, a missing entry, or one that is
 * corrupt, of another version or written for someone else reads as `undefined`
 * (and is removed), so the caller falls back to the network.
 */
export const readThreadListCache = (userId: string | undefined, storage: Storage | undefined = getThreadListStorage()): PersistedThreadList | undefined => {
    if (!userId || !storage) {
        return undefined;
    }

    try {
        const raw = storage.getItem(cacheKey(userId));

        if (raw === null) {
            return undefined;
        }

        const entry: unknown = JSON.parse(raw);

        if (isRecord(entry) && entry.v === CACHE_VERSION && entry.userId === userId && isPersistedList(entry.data)) {
            return entry.data;
        }

        storage.removeItem(cacheKey(userId));
    } catch {
        // Unreadable: the network path is the fallback.
    }

    return undefined;
};

/** Stores the projection of `data` for `userId`. Best effort: a full or unavailable store is ignored. */
export const writeThreadListCache = (userId: string | undefined, data: unknown, storage: Storage | undefined = getThreadListStorage()): void => {
    if (!userId || !storage) {
        return;
    }

    try {
        const projected = projectThreadList(data, userId);

        if (projected) {
            storage.setItem(cacheKey(userId), JSON.stringify({ data: projected, userId, v: CACHE_VERSION }));
        }
    } catch {
        // Quota or a disabled store: the list just is not cached.
    }
};

/** Removes every user's stored list. For sign-out and anonymous-account conversion. */
export const clearThreadListCache = (storage: Storage | undefined = getThreadListStorage()): void => {
    clears.count += 1;

    if (!storage) {
        return;
    }

    try {
        const keys: string[] = [];

        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);

            if (key?.startsWith(CACHE_PREFIX)) {
                keys.push(key);
            }
        }

        for (const key of keys) {
            storage.removeItem(key);
        }
    } catch {
        // Nothing to clear when the store is unavailable.
    }
};

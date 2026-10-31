import type { SqlDatabase, SqlParameter as SqlParametereter } from "./sql";
import type { CachedMessage, CachedStatus, CachedThread, MessageRow, StatusRow, ThreadRow } from "./types";

export const MAX_MESSAGES_PER_THREAD = 50;
export const MAX_THREADS_WITH_MESSAGES = 20;
/** The list screen pages in 100 at a time; older rows past this are evicted, not deleted from the server. */
export const MAX_CACHED_THREADS = 200;
export const MAX_CACHED_STATUSES = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cached_threads (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    runner TEXT,
    updated_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cached_messages (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cached_messages_by_thread ON cached_messages (thread_id, created_at);
CREATE TABLE IF NOT EXISTS cached_statuses (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    thread_id TEXT,
    last_seen_at INTEGER,
    updated_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
);
`;

/** SQL has NULL where the app has `undefined`. */
// eslint-disable-next-line unicorn/no-null -- the one place `undefined` becomes a NULL column
const orNull = <T extends number | string>(value: T | undefined): T | null => value ?? null;

const TABLES = ["cached_messages", "cached_statuses", "cached_threads", "cache_meta"] as const;

/**
 * Stored in the file (`PRAGMA user_version`). A file written under another version is only a cache: its tables are
 * dropped and recreated, never migrated. Bump it whenever SCHEMA changes.
 */
const SCHEMA_VERSION = 1;

/** The version guard of every upsert: a row is replaced only by a copy that is at least as new. */
const newerThan = (table: string) =>
    `WHERE excluded.updated_at > ${table}.updated_at OR (excluded.updated_at = ${table}.updated_at AND excluded.synced_at >= ${table}.synced_at)`;

const RECENT_THREAD_IDS = `SELECT id FROM cached_threads ORDER BY updated_at DESC, id DESC LIMIT ${MAX_THREADS_WITH_MESSAGES}`;

interface ThreadSql {
    id: string;
    runner: string | null;
    status: string;
    synced_at: number;
    title: string;
    updated_at: number;
}

interface MessageSql {
    created_at: number;
    id: string;
    role: string;
    status: string;
    synced_at: number;
    text: string;
    thread_id: string;
    updated_at: number;
}

interface StatusSql {
    id: string;
    kind: string;
    label: string;
    last_seen_at: number | null;
    status: string;
    synced_at: number;
    thread_id: string | null;
    updated_at: number;
}

export interface SaveOptions {
    /** When the read that produced these rows STARTED. A later save of an older read then loses to a newer one; defaults to the save time. */
    syncedAt?: number;
}

/** One signed-in account's view of the cache. Once the account signs out or another binds, every call does nothing. */
export interface ScopedCache {
    /**
     * Removes threads, their messages and their statuses. For a thread the server reports as locked after it was saved:
     * that is a positive signal, unlike a thread merely missing from a page.
     */
    forgetThreads: (threadIds: ReadonlyArray<string>) => Promise<void>;
    loadMessages: (threadId: string) => Promise<MessageRow[]>;
    loadStatuses: () => Promise<StatusRow[]>;
    loadThreads: () => Promise<ThreadRow[]>;
    saveMessages: (threadId: string, messages: ReadonlyArray<CachedMessage>, options?: SaveOptions) => Promise<void>;
    saveStatuses: (statuses: ReadonlyArray<CachedStatus>, options?: SaveOptions) => Promise<void>;
    saveThreads: (threads: ReadonlyArray<CachedThread>, options?: SaveOptions) => Promise<void>;
}

export interface OfflineCache {
    /** Makes `userId` the cache's account. Rows another account left behind are emptied first. */
    bindOwner: (userId: string) => Promise<void>;
    /** Empties every table and unbinds the account. Sign-out calls this. */
    clear: () => Promise<void>;
    forOwner: (userId: string) => ScopedCache;
}

/**
 * The read-only cache. Every row carries `syncedAt`, a save never replaces a newer row, and a save that omits a
 * row never deletes it. Nothing here records a write for later: there is no table for one.
 */
export const createOfflineCache = (database: SqlDatabase, { now = Date.now }: { now?: () => number } = {}): OfflineCache => {
    let owner: string | undefined;
    // One operation at a time, in call order, so a clear lands after the saves it follows and before the ones after it.
    let tail: Promise<unknown> = Promise.resolve();
    let ready: Promise<void> | undefined;

    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const run = async () => {
            await tail;

            return task();
        };
        const result = run();

        // The caller sees a failure; the next operation only waits for this one to end.
        tail = (async () => {
            try {
                await result;
            } catch {
                // Reported through `result`.
            }
        })();

        return result;
    };

    const setUp = async () => {
        const [stored] = await database.getAllAsync<{ user_version: number }>("PRAGMA user_version");

        if (stored?.user_version !== SCHEMA_VERSION) {
            for (const table of TABLES) {
                // eslint-disable-next-line no-await-in-loop -- one statement after the other
                await database.execAsync(`DROP TABLE IF EXISTS ${table}`);
            }

            await database.execAsync("DROP INDEX IF EXISTS cached_messages_by_thread");
        }

        await database.execAsync(SCHEMA);
        // Last, so a setup that died half-way is run again from the start.
        await database.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    };

    const open = async () => {
        ready ??= setUp();

        try {
            await ready;
        } catch (error) {
            // A setup that failed once (a full disk, a locked file) must not fail every later call, `clear()` included.
            ready = undefined;

            throw error;
        }
    };

    const wipe = async () => {
        await database.withTransactionAsync(async () => {
            for (const table of TABLES) {
                // eslint-disable-next-line no-await-in-loop -- statements of one transaction run in order
                await database.runAsync(`DELETE FROM ${table}`);
            }
        });
    };

    /**
     * Messages are kept for the most recent threads only. A thread the list has not stored yet (a chat started on this
     * phone) is kept too, within the same count, until the list save either lists it or evicts it.
     */
    const keepsMessagesOf = async (threadId: string): Promise<boolean> => {
        const recent = await database.getAllAsync<{ id: string }>(RECENT_THREAD_IDS);

        if (recent.some((row) => row.id === threadId)) {
            return true;
        }

        const [listed] = await database.getAllAsync<{ id: string }>("SELECT id FROM cached_threads WHERE id = ?", [threadId]);

        if (listed !== undefined) {
            return false;
        }

        const unlisted = await database.getAllAsync<{ thread_id: string }>(
            "SELECT DISTINCT thread_id FROM cached_messages WHERE thread_id NOT IN (SELECT id FROM cached_threads)",
        );

        return unlisted.some((row) => row.thread_id === threadId) || unlisted.length < MAX_THREADS_WITH_MESSAGES;
    };

    const forOwner = (userId: string): ScopedCache => {
        const scoped = async <T>(fallback: T, task: () => Promise<T>): Promise<T> =>
            enqueue(async () => {
                if (owner !== userId) {
                    return fallback;
                }

                await open();

                return task();
            });

        return {
            forgetThreads: (threadIds) =>
                scoped<undefined>(undefined, async () => {
                    await database.withTransactionAsync(async () => {
                        for (const threadId of threadIds) {
                            // eslint-disable-next-line no-await-in-loop -- statements of one transaction run in order
                            await database.runAsync("DELETE FROM cached_messages WHERE thread_id = ?", [threadId]);
                            // eslint-disable-next-line no-await-in-loop -- as above
                            await database.runAsync("DELETE FROM cached_statuses WHERE thread_id = ?", [threadId]);
                            // eslint-disable-next-line no-await-in-loop -- as above
                            await database.runAsync("DELETE FROM cached_threads WHERE id = ?", [threadId]);
                        }
                    });
                }),
            loadMessages: (threadId) =>
                scoped<MessageRow[]>([], async () => {
                    const rows = await database.getAllAsync<MessageSql>("SELECT * FROM cached_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC", [
                        threadId,
                    ]);

                    return rows.map((row) => {
                        return {
                            createdAt: row.created_at,
                            id: row.id,
                            role: row.role,
                            status: row.status,
                            syncedAt: row.synced_at,
                            text: row.text,
                            threadId: row.thread_id,
                            updatedAt: row.updated_at,
                        };
                    });
                }),
            loadStatuses: () =>
                scoped<StatusRow[]>([], async () => {
                    const rows = await database.getAllAsync<StatusSql>("SELECT * FROM cached_statuses ORDER BY updated_at DESC, id DESC");

                    return rows.map((row) => {
                        return {
                            id: row.id,
                            kind: row.kind === "worker" ? "worker" : "host",
                            label: row.label,
                            status: row.status,
                            syncedAt: row.synced_at,
                            ...row.last_seen_at !== null && { lastSeenAt: row.last_seen_at },
                            ...row.thread_id !== null && { threadId: row.thread_id },
                            updatedAt: row.updated_at,
                        };
                    });
                }),
            loadThreads: () =>
                scoped<ThreadRow[]>([], async () => {
                    const rows = await database.getAllAsync<ThreadSql>("SELECT * FROM cached_threads ORDER BY updated_at DESC, id DESC");

                    return rows.map((row) => {
                        return {
                            id: row.id,
                            status: row.status,
                            syncedAt: row.synced_at,
                            title: row.title,
                            updatedAt: row.updated_at,
                            ...row.runner === "host" && { runner: "host" as const },
                        };
                    });
                }),
            saveMessages: (threadId, messages, options) =>
                scoped<undefined>(undefined, async () => {
                    if (!await keepsMessagesOf(threadId)) {
                        return;
                    }

                    const syncedAt = options?.syncedAt ?? now();

                    await database.withTransactionAsync(async () => {
                        for (const message of messages) {
                            const params: SqlParametereter[] = [
                                message.id,
                                threadId,
                                message.role,
                                message.text,
                                message.status,
                                message.createdAt,
                                message.updatedAt ?? message.createdAt,
                                syncedAt,
                            ];

                            // eslint-disable-next-line no-await-in-loop -- statements of one transaction run in order
                            await database.runAsync(
                                `INSERT INTO cached_messages (id, thread_id, role, text, status, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(id) DO UPDATE SET role = excluded.role, text = excluded.text, status = excluded.status, created_at = excluded.created_at,
                                     updated_at = excluded.updated_at, synced_at = excluded.synced_at
                                 ${newerThan("cached_messages")}`,
                                params,
                            );
                        }

                        await database.runAsync(
                            `DELETE FROM cached_messages WHERE thread_id = ? AND id NOT IN (
                                 SELECT id FROM cached_messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ${MAX_MESSAGES_PER_THREAD})`,
                            [threadId, threadId],
                        );
                    });
                }),
            saveStatuses: (statuses, options) =>
                scoped<undefined>(undefined, async () => {
                    const syncedAt = options?.syncedAt ?? now();

                    await database.withTransactionAsync(async () => {
                        for (const row of statuses) {
                            // eslint-disable-next-line no-await-in-loop -- statements of one transaction run in order
                            await database.runAsync(
                                `INSERT INTO cached_statuses (id, kind, label, status, thread_id, last_seen_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, status = excluded.status, thread_id = excluded.thread_id,
                                     last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at, synced_at = excluded.synced_at
                                 ${newerThan("cached_statuses")}`,
                                [row.id, row.kind, row.label, row.status, orNull(row.threadId), orNull(row.lastSeenAt), row.updatedAt, syncedAt],
                            );
                        }

                        // A finished worker run drops out of the live list and would otherwise stay here for good.
                        await database.runAsync(
                            `DELETE FROM cached_statuses WHERE id NOT IN (SELECT id FROM cached_statuses ORDER BY updated_at DESC, id DESC LIMIT ${MAX_CACHED_STATUSES})`,
                        );
                    });
                }),
            saveThreads: (threads, options) =>
                scoped<undefined>(undefined, async () => {
                    const syncedAt = options?.syncedAt ?? now();

                    await database.withTransactionAsync(async () => {
                        for (const thread of threads) {
                            // eslint-disable-next-line no-await-in-loop -- statements of one transaction run in order
                            await database.runAsync(
                                `INSERT INTO cached_threads (id, title, status, runner, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, runner = excluded.runner,
                                     updated_at = excluded.updated_at, synced_at = excluded.synced_at
                                 ${newerThan("cached_threads")}`,
                                [thread.id, thread.title, thread.status, orNull(thread.runner), thread.updatedAt, syncedAt],
                            );
                        }

                        // Eviction keeps the cache bounded. It says nothing about the server: an evicted thread still exists.
                        await database.runAsync(
                            `DELETE FROM cached_threads WHERE id NOT IN (SELECT id FROM cached_threads ORDER BY updated_at DESC, id DESC LIMIT ${MAX_CACHED_THREADS})`,
                        );
                        await database.runAsync(`DELETE FROM cached_messages WHERE thread_id NOT IN (${RECENT_THREAD_IDS})`);
                    });
                }),
        };
    };

    return {
        bindOwner: (userId) =>
            enqueue(async () => {
                await open();

                const [stored] = await database.getAllAsync<{ value: string }>("SELECT value FROM cache_meta WHERE key = 'owner'");

                if (stored !== undefined && stored.value !== userId) {
                    await wipe();
                }

                await database.runAsync("INSERT INTO cache_meta (key, value) VALUES ('owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
                    userId,
                ]);
                owner = userId;
            }),
        clear: () => {
            // Unbound at once, so a save already on its way from a screen of the old account finds nobody to save for.
            owner = undefined;

            return enqueue(async () => {
                // Again, in order: a bind queued before this clear has run by now and must not outlive it.
                owner = undefined;
                await open();
                await wipe();
            });
        },
        forOwner,
    };
};

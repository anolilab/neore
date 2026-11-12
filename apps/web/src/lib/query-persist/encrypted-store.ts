/**
 * One encrypted record per account in IndexedDB.
 *
 * The record is AES-GCM ciphertext under a key made for that account in this
 * browser. The key is a NON-EXTRACTABLE `CryptoKey`, stored as the object itself
 * (IndexedDB clones it structurally) beside a random id that tells one key from the
 * next, so its bytes never exist in script: what is
 * on disk is useless without this browser profile's key store. The record's name
 * is the additional data, so a record moved to another account's name fails to
 * decrypt. Removing an account removes its key as well as its record, in one transaction. The time a record was
 * written is kept beside the ciphertext, so an account not opened for a long time can be dropped unread.
 */

export const DATABASE_NAME = "neore-qc";
const DATABASE_VERSION = 1;
const KEYS = "keys";
const ENTRIES = "entries";

type StoreName = typeof ENTRIES | typeof KEYS;

/** The record name of one account's cache: the additional data it is sealed with. Both stores are keyed by user id. */
export const entryName = (userId: string): string => `neore-qc:v1:${userId}`;

/** The slice of IndexedDB this needs, so tests can stand in for it. Values are stored by structured clone. */
export interface RecordStore {
    get: (store: StoreName, key: string) => Promise<unknown>;

    /**
     * In one transaction over both stores (a clear may land between the key's read and the write otherwise): stores
     * `entry` as the account's entry only while its stored key passes `isKeyCurrent`, and answers whether it did.
     */
    putEntry: (userId: string, entry: unknown, isKeyCurrent: (storedKey: unknown) => boolean) => Promise<boolean>;
    /** Stores `value` unless the key holds one already, in one transaction (another tab may race), and answers what is stored. */
    putIfAbsent: (store: StoreName, key: string, value: unknown) => Promise<unknown>;

    /**
     * In one transaction over both stores (another tab may save in between otherwise): removes the entry and the key of
     * each account in `userIds` (every account with an entry when omitted) whose entry, as stored then, passes
     * `shouldRemove`. With neither, empties both stores.
     */
    remove: (userIds?: ReadonlyArray<string>, shouldRemove?: (entry: unknown) => boolean) => Promise<void>;
}

const failure = (error: DOMException | null): Error => error ?? new Error("IndexedDB request failed");

const settle = async <T>(request: IDBRequest<T>): Promise<T> =>
    await new Promise((resolve, reject) => {
        request.addEventListener("success", () => {
            resolve(request.result);
        });
        request.addEventListener("error", () => {
            reject(failure(request.error));
        });
    });

/** A write is done when its transaction commits, not when its request succeeds: a quota error or an abort shows only there. */
const committed = async (transaction: IDBTransaction): Promise<void> =>
    await new Promise((resolve, reject) => {
        transaction.addEventListener("complete", () => {
            resolve();
        });
        transaction.addEventListener("error", () => {
            reject(failure(transaction.error));
        });
        transaction.addEventListener("abort", () => {
            reject(failure(transaction.error));
        });
    });

/** `onGone` hears the connection closing (site data cleared, another tab upgrading), so the next call opens again. */
const openDatabase = async (factory: IDBFactory, onGone: () => void): Promise<IDBDatabase> => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);

    request.addEventListener("upgradeneeded", () => {
        for (const name of [KEYS, ENTRIES]) {
            if (!request.result.objectStoreNames.contains(name)) {
                request.result.createObjectStore(name);
            }
        }
    });

    const opened = await settle(request);
    const gone = (): void => {
        opened.close();
        onGone();
    };

    opened.addEventListener("close", gone);
    opened.addEventListener("versionchange", gone);

    return opened;
};

/** IndexedDB as a {@link RecordStore}, or `undefined` where there is none (server, blocked storage). */
export const indexedDatabaseStore = (): RecordStore | undefined => {
    let factory: IDBFactory | undefined;

    try {
        factory = globalThis.indexedDB ?? undefined;
    } catch {
        factory = undefined;
    }

    if (!factory) {
        return undefined;
    }

    const idb = factory;
    let database: Promise<IDBDatabase> | undefined;

    const open = async (): Promise<IDBDatabase> => {
        database ??= openDatabase(idb, () => {
            database = undefined;
        }).catch((error: unknown) => {
            database = undefined;

            throw error;
        });

        return await database;
    };

    const write = async (store: StoreName, operation: (objectStore: IDBObjectStore) => void): Promise<void> => {
        const opened = await open();
        const transaction = opened.transaction(store, "readwrite");

        operation(transaction.objectStore(store));
        await committed(transaction);
    };

    const remove: RecordStore["remove"] = async (userIds, shouldRemove) => {
        const opened = await open();
        const transaction = opened.transaction([ENTRIES, KEYS], "readwrite");
        const entries = transaction.objectStore(ENTRIES);
        const keys = transaction.objectStore(KEYS);
        const removeIf = (userId: string, entry: unknown): void => {
            if (shouldRemove !== undefined && !shouldRemove(entry)) {
                return;
            }

            entries.delete(userId);
            keys.delete(userId);
        };

        if (userIds) {
            for (const userId of userIds) {
                const entry = entries.get(userId);

                entry.addEventListener("success", () => {
                    removeIf(userId, entry.result);
                });
            }
        } else if (shouldRemove) {
            const cursor = entries.openCursor();

            cursor.addEventListener("success", () => {
                if (!cursor.result) {
                    return;
                }

                removeIf(String(cursor.result.key), cursor.result.value);
                cursor.result.continue();
            });
        } else {
            entries.clear();
            keys.clear();
        }

        await committed(transaction);
    };

    return {
        get: async (store, key) => {
            const opened = await open();

            return await settle(opened.transaction(store, "readonly").objectStore(store).get(key));
        },
        putEntry: async (userId, entry, isKeyCurrent) => {
            const opened = await open();
            const transaction = opened.transaction([ENTRIES, KEYS], "readwrite");
            const storedKey = transaction.objectStore(KEYS).get(userId);
            let isWritten = false;

            storedKey.addEventListener("success", () => {
                if (!isKeyCurrent(storedKey.result)) {
                    return;
                }

                transaction.objectStore(ENTRIES).put(entry, userId);
                isWritten = true;
            });
            await committed(transaction);

            return isWritten;
        },
        putIfAbsent: async (store, key, value) => {
            let stored: unknown = value;

            await write(store, (objectStore) => {
                const existing = objectStore.get(key);

                existing.addEventListener("success", () => {
                    if (existing.result === undefined) {
                        objectStore.put(value, key);
                    } else {
                        stored = existing.result;
                    }
                });
            });

            return stored;
        },
        remove,
    };
};

interface SealedRecord {
    data: ArrayBuffer;
    iv: Uint8Array;
    /** When it was sealed, in the clear: lets {@link pruneRecords} drop an account nobody opens without reading it. */
    writtenAt: number;
}

const isSealedRecord = (value: unknown): value is SealedRecord =>
    typeof value === "object" &&
    value !== null &&
    (value as SealedRecord).data instanceof ArrayBuffer &&
    (value as SealedRecord).iv instanceof Uint8Array &&
    typeof (value as SealedRecord).writtenAt === "number";

/** Which write a stored entry is: every seal draws a fresh IV. */
const sealOf = (entry: unknown): string | undefined => {
    if (entry === undefined) {
        return undefined;
    }

    return isSealedRecord(entry) ? Array.from(entry.iv, (byte) => byte.toString(16).padStart(2, "0")).join("") : "unreadable";
};

interface AccountKey {
    /** Tells this key from one made after it was removed: a stored clone is never the same object. */
    id: string;
    key: CryptoKey;
}

const isAccountKey = (value: unknown): value is AccountKey =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as AccountKey).id === "string" &&
    typeof CryptoKey !== "undefined" &&
    (value as AccountKey).key instanceof CryptoKey;

const accountKey = async (store: RecordStore, userId: string, create: boolean): Promise<AccountKey | undefined> => {
    const stored = await store.get(KEYS, userId);

    if (isAccountKey(stored)) {
        return stored;
    }

    if (!create) {
        return undefined;
    }

    const key = await crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    // Another tab of the same account may have made one meanwhile: both must seal under the same key.
    const kept = await store.putIfAbsent(KEYS, userId, { id: crypto.randomUUID(), key } satisfies AccountKey);

    return isAccountKey(kept) ? kept : undefined;
};

const additionalData = (userId: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(entryName(userId));

/**
 * Encrypts `text` under the account's key (made on first use) and stores it as the account's one record. Answers which
 * write it stored, for {@link removeRecord}, or `undefined` when it stored nothing: the key was removed (a clear, a
 * prune) or replaced while the text was sealed, and ciphertext under a key no longer stored could never be opened.
 */
export const sealRecord = async (store: RecordStore, userId: string, text: string, writtenAt: number = Date.now()): Promise<string | undefined> => {
    const sealingKey = await accountKey(store, userId, true);

    if (!sealingKey) {
        return undefined;
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ additionalData: additionalData(userId), iv, name: "AES-GCM" }, sealingKey.key, new TextEncoder().encode(text));
    const entry: SealedRecord = { data, iv, writtenAt };
    const isWritten = await store.putEntry(userId, entry, (storedKey) => isAccountKey(storedKey) && storedKey.id === sealingKey.id);

    return isWritten ? sealOf(entry) : undefined;
};

export interface OpenedRecord {
    /** Which write was read: given to {@link removeRecord}, it removes the record only while it is still that one. */
    readonly seal: string;
    /** The plaintext, or `undefined` when the record is there but cannot be read (a lost key, another shape). */
    readonly text: string | undefined;
}

/** The account's record decrypted, or `undefined` when there is none. */
export const openRecord = async (store: RecordStore, userId: string): Promise<OpenedRecord | undefined> => {
    const sealed = await store.get(ENTRIES, userId);
    const seal = sealOf(sealed);

    if (seal === undefined) {
        return undefined;
    }

    const openingKey = await accountKey(store, userId, false);

    if (!openingKey || !isSealedRecord(sealed)) {
        return { seal, text: undefined };
    }

    try {
        const plain = await crypto.subtle.decrypt(
            { additionalData: additionalData(userId), iv: sealed.iv as Uint8Array<ArrayBuffer>, name: "AES-GCM" },
            openingKey.key,
            sealed.data,
        );

        return { seal, text: new TextDecoder().decode(plain) };
    } catch {
        return { seal, text: undefined };
    }
};

/** Removes the account's record and its key; with `seal`, only while the stored record is still the one read. */
export const removeRecord = async (store: RecordStore, userId: string, seal?: string): Promise<void> => {
    await store.remove([userId], seal === undefined ? undefined : (entry) => sealOf(entry) === seal);
};

/** Removes the record and key of every account whose record was written before `writtenBefore`, unread. */
export const pruneRecords = async (store: RecordStore, writtenBefore: number): Promise<void> => {
    await store.remove(undefined, (entry) => !isSealedRecord(entry) || entry.writtenAt < writtenBefore);
};

/** Removes every account's record and key. */
export const removeAllRecords = async (store: RecordStore): Promise<void> => {
    await store.remove();
};

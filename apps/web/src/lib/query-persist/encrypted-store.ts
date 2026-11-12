/**
 * One encrypted record per account in IndexedDB.
 *
 * The record is AES-GCM ciphertext under a key made for that account in this
 * browser. The key is a NON-EXTRACTABLE `CryptoKey`, stored as the object itself
 * (IndexedDB clones it structurally), so its bytes never exist in script: what is
 * on disk is useless without this browser profile's key store. The record's name
 * is the additional data, so a record moved to another account's name fails to
 * decrypt. Removing an account removes its key as well as its record.
 */

export const DATABASE_NAME = "neore-qc";
const DATABASE_VERSION = 1;
const KEYS = "keys";
const ENTRIES = "entries";

type StoreName = typeof ENTRIES | typeof KEYS;

/** The record name of one account's cache. */
export const entryName = (userId: string): string => `neore-qc:v1:${userId}`;

/** The slice of IndexedDB this needs, so tests can stand in for it. Values are stored by structured clone. */
export interface RecordStore {
    clear: (store: StoreName) => Promise<void>;
    delete: (store: StoreName, key: string) => Promise<void>;
    get: (store: StoreName, key: string) => Promise<unknown>;
    put: (store: StoreName, key: string, value: unknown) => Promise<void>;
    /** Stores `value` unless the key holds one already, in one transaction (another tab may race), and answers what is stored. */
    putIfAbsent: (store: StoreName, key: string, value: unknown) => Promise<unknown>;
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

    return {
        clear: async (store) => {
            await write(store, (objectStore) => objectStore.clear());
        },
        delete: async (store, key) => {
            await write(store, (objectStore) => objectStore.delete(key));
        },
        get: async (store, key) => {
            const opened = await open();

            return await settle(opened.transaction(store, "readonly").objectStore(store).get(key));
        },
        put: async (store, key, value) => {
            await write(store, (objectStore) => objectStore.put(value, key));
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
    };
};

interface SealedRecord {
    data: ArrayBuffer;
    iv: Uint8Array;
}

const isSealedRecord = (value: unknown): value is SealedRecord =>
    typeof value === "object" && value !== null && (value as SealedRecord).data instanceof ArrayBuffer && (value as SealedRecord).iv instanceof Uint8Array;

const isCryptoKey = (value: unknown): value is CryptoKey => typeof CryptoKey !== "undefined" && value instanceof CryptoKey;

const accountKey = async (store: RecordStore, userId: string, create: boolean): Promise<CryptoKey | undefined> => {
    const stored = await store.get(KEYS, userId);

    if (isCryptoKey(stored)) {
        return stored;
    }

    if (!create) {
        return undefined;
    }

    const key = await crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    // Another tab of the same account may have made one meanwhile: both must seal under the same key.
    const kept = await store.putIfAbsent(KEYS, userId, key);

    return isCryptoKey(kept) ? kept : undefined;
};

const additionalData = (userId: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(entryName(userId));

/** Encrypts `text` under the account's key (made on first use) and stores it as the account's one record. */
export const sealRecord = async (store: RecordStore, userId: string, text: string): Promise<void> => {
    const key = await accountKey(store, userId, true);

    if (!key) {
        return;
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ additionalData: additionalData(userId), iv, name: "AES-GCM" }, key, new TextEncoder().encode(text));

    await store.put(ENTRIES, entryName(userId), { data, iv } satisfies SealedRecord);
};

/** The account's record decrypted, or `undefined` when there is none. Throws when it is there but cannot be read. */
export const openRecord = async (store: RecordStore, userId: string): Promise<string | undefined> => {
    const sealed = await store.get(ENTRIES, entryName(userId));

    if (sealed === undefined) {
        return undefined;
    }

    const key = await accountKey(store, userId, false);

    if (!key || !isSealedRecord(sealed)) {
        throw new Error("Unreadable query cache record");
    }

    const plain = await crypto.subtle.decrypt(
        { additionalData: additionalData(userId), iv: sealed.iv as Uint8Array<ArrayBuffer>, name: "AES-GCM" },
        key,
        sealed.data,
    );

    return new TextDecoder().decode(plain);
};

/** Removes the account's record and its key. */
export const removeRecord = async (store: RecordStore, userId: string): Promise<void> => {
    await store.delete(ENTRIES, entryName(userId));
    await store.delete(KEYS, userId);
};

/** Removes every account's record and key. */
export const removeAllRecords = async (store: RecordStore): Promise<void> => {
    await store.clear(ENTRIES);
    await store.clear(KEYS);
};

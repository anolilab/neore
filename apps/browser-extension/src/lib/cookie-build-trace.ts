/** Where the Lunora client keeps its read cache by default (`createIndexedDbQueryCache`). */
const QUERY_CACHE_DATABASE = "lunora-query-cache";
const QUERY_CACHE_STORE = "query-cache";

const settle = async <T>(request: IDBRequest<T>): Promise<T> =>
    await new Promise((resolve, reject) => {
        request.addEventListener("success", () => {
            resolve(request.result);
        });
        request.addEventListener("error", () => {
            reject(request.error ?? new Error("IndexedDB request failed"));
        });
    });

/**
 * Opens the read cache as it is, or answers `undefined` when there is none.
 * Creating it here would leave it without the client's store, and the client
 * opens it at the same version, so it would never add one: an open that would
 * create it (gone between `databases()` and `open()`) is aborted.
 */
const openExisting = async (idb: IDBFactory): Promise<IDBDatabase | undefined> => {
    const databases = await idb.databases();

    if (databases.every((database) => database.name !== QUERY_CACHE_DATABASE)) {
        return undefined;
    }

    const request = idb.open(QUERY_CACHE_DATABASE);
    let created = false;

    request.addEventListener("upgradeneeded", () => {
        created = true;
        request.transaction?.abort();
    });

    try {
        return await settle(request);
    } catch (error) {
        if (created) {
            return undefined;
        }

        throw error;
    }
};

/**
 * Whether the cookie build left a signed-in trace: a read it cached under a
 * user. That build queried only behind its session check, and the client
 * stamps each cached read with the identity it was read as (`null` when the
 * server named nobody) and empties the cache when that identity changes, so a
 * read stamped with a user means that user was still signed in. Nothing else
 * the cookie build stored says so: the cookie itself is out of reach (no host
 * permission for the app, and the backend strips it from extension requests).
 */
export const hasCookieBuildReads = async (idb: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): Promise<boolean> => {
    if (!idb?.databases) {
        return false;
    }

    const database = await openExisting(idb);

    if (!database) {
        return false;
    }

    try {
        if (!database.objectStoreNames.contains(QUERY_CACHE_STORE)) {
            return false;
        }

        const entries = await settle(database.transaction(QUERY_CACHE_STORE, "readonly").objectStore(QUERY_CACHE_STORE).getAll());

        return entries.some((entry: { identity?: unknown }) => typeof entry.identity === "string");
    } finally {
        database.close();
    }
};

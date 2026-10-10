/**
 * Small collection helpers.
 *
 * These were helper re-exports during the port. They are plain
 * TypeScript with nothing platform-specific in them, so they live here rather
 * than behind a compatibility shim.
 */

/**
 * Lexicographic comparator over UTF-16 code units — the ordering `Array#sort`
 * applies to strings by default.
 *
 * Used where the ordering is part of a wire format (HMAC canonicalisation of a
 * query string), so it must be byte-stable and must NOT be `localeCompare`,
 * which is locale-dependent.
 */
export const compareStrings = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

/** `Promise.all` over a map, with the index passed through. */
export const asyncMap = async <T, R>(list: Iterable<T>, function_: (item: T, index: number) => Promise<R> | R): Promise<R[]> =>
    await Promise.all([...list].map((item, index) => function_(item, index)));

/** A new object with only `keys`. Missing keys are not invented. */
export const pick = <T extends object, K extends keyof T>(object: T, keys: ReadonlyArray<K>): Pick<T, K> => {
    const result = {} as Pick<T, K>;

    for (const key of keys) {
        if (Object.hasOwn(object, key)) {
            result[key] = object[key];
        }
    }

    return result;
};

/** A new object without `keys`. */
export const omit = <T extends object, K extends keyof T>(object: T, keys: ReadonlyArray<K>): Omit<T, K> => {
    const result = { ...object };

    for (const key of keys) {
        delete result[key];
    }

    return result as Omit<T, K>;
};

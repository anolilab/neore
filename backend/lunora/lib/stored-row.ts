/**
 * A `.global()` row typed as the store returns it.
 *
 * Since `@lunora/codegen@alpha.428`, `Doc_*` types every optional column of a `.global()` table `?: T | null`. The
 * store never reads one back as `null`: `@lunora/sql-store`'s row decoder drops a NULL optional column, and the shard
 * engine leaves an unset one absent (`stored-row.test.ts` pins the second). The output validators, the API types the
 * clients compile against and the helpers that take a row all declare such a column `?: T`, so a row read from the
 * store is narrowed here, at the read, rather than every reader learning a `null` that never arrives.
 *
 * It narrows the type only. A column that is required and nullable (`logo: string | null`) keeps its `null`; no
 * `.global()` table in `schema.ts` has an optional column whose own validator admits `null`.
 */
export type StoredRow<T> = T extends object ? { [K in keyof T]: undefined extends T[K] ? Exclude<T[K], null> : T[K] } : T;

/** One row, or the `null` / `undefined` of a read that found none. */
export const storedRow = <T>(row: T): StoredRow<T> => row as StoredRow<T>;

export const storedRows = <T extends object>(rows: ReadonlyArray<T>): StoredRow<T>[] => rows as StoredRow<T>[];

/** A `findMany` result whose rows are narrowed like {@link storedRow}'s. */
export const storedPage = <P extends { page: ReadonlyArray<object> }>(result: P): Omit<P, "page"> & { page: StoredRow<P["page"][number]>[] } =>
    result as unknown as Omit<P, "page"> & { page: StoredRow<P["page"][number]>[] };

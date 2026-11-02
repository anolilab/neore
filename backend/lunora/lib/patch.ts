/**
 * Writing a row without tripping over `undefined`.
 *
 * `ctx.db.patch` refuses `undefined` as a field value at runtime ("Cannot patch
 * field 'x' to undefined") although its type accepts it. And `null` is no way to
 * clear a `v.optional(...)` column either: the write succeeds, but the row then
 * reads back with `x: null`, which every output validator declaring that column
 * `v.optional` rejects ("Response did not match the declared output schema").
 * Removing a field therefore means REPLACING the row without it.
 *
 * - {@link withoutUndefined}: `undefined` means "leave it unchanged" (a partial
 *   update whose absent fields keep their stored value).
 * - {@link patchRow} / {@link patchById}: `undefined` means "remove the field".
 *
 * `patch-undefined.guard.test.ts` type-checks every `db.patch` call and fails on
 * one that can still pass `undefined`.
 */
import type { Id, TableName } from "../_generated/dataModel";

/**
 * With `exactOptionalPropertyTypes` off, an optional key always reads as
 * `T | undefined`, so the type alone cannot say "stripped". The brand does: the
 * guard test trusts a value carrying it. It never exists at runtime.
 */
// A type alias, not an interface: only an alias gets the implicit index
// signature `ctx.db.patch`'s `Record<string, unknown>` parameter needs.

export type UndefinedStripped = { readonly __undefinedStripped?: never };

export type Defined<T> = UndefinedStripped & { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops the keys whose value is `undefined`; everything else, `null` included, is kept. */
export const withoutUndefined = <T extends object>(fields: T): Defined<T> =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Defined<T>;

// `never` parameters: the real writer's by-id methods are generic over the table, and a
// `never` target accepts any of them. `table` and `row._id` are tied together below.
interface RowWriter {
    get: (table: never, id: never) => Promise<unknown>;
    patch: (table: never, id: never, value: never) => Promise<unknown>;
    replace: (table: never, id: never, value: never) => Promise<unknown>;
}

/** System-managed keys (`_id`, `_creationTime`, …) are never written back. */
const isSystemKey = (key: string): boolean => key.startsWith("_");

/**
 * Applies `changes` to `row`, where a key set to `undefined` REMOVES that field.
 * With nothing to remove it is a plain patch; otherwise the row is replaced from
 * its current contents minus the removed keys.
 */
export const patchRow = async <T extends TableName, R extends { _id: Id<T> }>(
    db: Pick<RowWriter, "patch" | "replace">,
    table: T,
    row: R,
    changes: object,
): Promise<void> => {
    const entries = Object.entries(changes);
    const removed = new Set(entries.filter(([, value]) => value === undefined).map(([key]) => key));

    if (removed.size === 0) {
        await db.patch(table as never, row._id as never, changes as never);

        return;
    }

    const next = Object.fromEntries(
        Object.entries({ ...row, ...changes }).filter(([key, value]) => !isSystemKey(key) && !removed.has(key) && value !== undefined),
    );

    await db.replace(table as never, row._id as never, next as never);
};

/** The same as {@link patchRow}, for a row not loaded yet. Returns `false`, writing nothing, when the row is gone. */
export const patchById = async <T extends TableName>(db: RowWriter, table: T, id: Id<T>, changes: object): Promise<boolean> => {
    const row = (await db.get(table as never, id as never)) as { _id: Id<T> } | null;

    if (!row) {
        return false;
    }

    await patchRow(db, table, row, changes);

    return true;
};

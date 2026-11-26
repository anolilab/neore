/**
 * Patching a row better-auth wrote.
 *
 * better-auth writes through `@lunora/auth`'s `lunoraD1Adapter`, which sets `supportsDates: false`, so better-auth's adapter
 * factory stores every date as an ISO string, past Lunora's validators, in columns `schema.ts` declares `v.number()`. Lunora's
 * writer validates every column of the row a `patch`/`patchIf` leaves, not only the patched ones, so any patch of such a row
 * answers `VALIDATION_ERROR`. {@link patchBetterAuthRow} rewrites the row's string dates as the epoch milliseconds they name
 * in the same write, guarded on the values it read: a write in between makes it miss rather than put back an older time.
 *
 * Only tables whose readers take a numeric date are listed. better-auth hands a stored number back unchanged (its factory
 * turns only a string into a `Date`), and its browser client revives only ISO strings, so a numeric `member.createdAt`
 * breaks `.getTime()` in the web members card, and numeric `session`/`verification`/`apikey` dates compare wrongly against
 * the ISO strings better-auth filters them with in SQL. Those tables wait for Lunora's adapter to store numbers.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Defined } from "./patch";

/** The date columns better-auth writes, per table this file may convert. */
export const BETTER_AUTH_DATE_COLUMNS = {
    organization: ["createdAt"],
    user: ["banExpires", "createdAt", "updatedAt"],
} as const;

export type BetterAuthDatedTable = keyof typeof BETTER_AUTH_DATE_COLUMNS;

type BetterAuthDateColumn = (typeof BETTER_AUTH_DATE_COLUMNS)[BetterAuthDatedTable][number];

/** A row's date columns: typed numbers, but a row better-auth wrote holds strings. */
type DatedRow = Partial<Record<BetterAuthDateColumn, number | string | null>>;

/** A conditional patch's dates: each string one as a number, and every date guarded on the value read. */
export interface DatesAsNumbers {
    patch: Record<string, number>;
    where: Record<string, number | string | null>;
}

/**
 * The epoch-millisecond form of `row`'s string dates and a guard on every date column as read (a number, a string, or none).
 * A string no clock reads is refused, never stored as some other time.
 */
export const datesAsNumbers = (table: BetterAuthDatedTable, row: DatedRow): DatesAsNumbers => {
    const patch: DatesAsNumbers["patch"] = {};
    const where: DatesAsNumbers["where"] = {};
    const columns: ReadonlyArray<BetterAuthDateColumn> = BETTER_AUTH_DATE_COLUMNS[table];

    for (const column of columns) {
        const stored = row[column];

        if (typeof stored !== "string") {
            where[column] = typeof stored === "number" ? stored : null;

            continue;
        }

        const epochMs = Date.parse(stored);

        if (!Number.isFinite(epochMs)) {
            throw new LunoraError("BAD_REQUEST", `A ${table} row's ${column} does not read as a time; fix the row first`);
        }

        patch[column] = epochMs;
        where[column] = stored;
    }

    return { patch, where };
};

/**
 * `ctx.db.patch(table, row._id, changes)` for a row better-auth may have written: a plain patch when its dates are numbers
 * already, otherwise one `patchIf` that also converts them. A row that changed since it was read answers `CONFLICT`.
 */
export const patchBetterAuthRow = async <T extends BetterAuthDatedTable>(
    db: MutationCtx["db"],
    table: T,
    row: DatedRow & { _id: Id<T> },
    changes: Defined<Partial<Record<string, boolean | number | string | string[] | null>>>,
): Promise<void> => {
    const { patch, where } = datesAsNumbers(table, row);

    if (Object.keys(patch).length === 0) {
        await db.patch(table as never, row._id as never, changes as never);

        return;
    }

    const { applied } = await db.patchIf(table as never, row._id as never, { patch: { ...patch, ...changes }, where } as never);

    if (!applied) {
        throw new LunoraError("CONFLICT", `The ${table} row changed meanwhile; try again`);
    }
};

/**
 * Fills `user.emailCanonical` on the rows that predate the column, with the `canonicalEmail` the auth plugin computes for a new
 * sign-up. `@lunora/auth` relies on the column's unique index to refuse a concurrent sign-up that repeats a folded address, and
 * the Worker never runs the plugin's own backfill (`ensureMigrated` is not called, see `src/server.ts`).
 *
 * `user` is a `.global()` D1 table, so a `defineMigration` cannot do this: it runs in each shard's Durable Object against
 * that shard's SQLite and never reaches D1. `canonicalEmail` folds Unicode (NFC, then a Unicode lower case), which SQLite's
 * `lower()` does not, so a SQL `UPDATE` cannot either. The deploy calls this through `POST /admin/backfill-email-canonical`
 * (`email-canonical-backfill-http.ts`) until it answers `done`; a run with nothing left reads once and writes nothing.
 *
 * Two rows that fold to one address are never resolved here: the run writes nothing and answers `conflict`, so neither row
 * is picked over the other. Merge or rename one of them, then deploy again.
 */
import { canonicalEmail } from "@lunora/auth";
import { v } from "lunorash/server";

import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";

/** Unfilled rows one scan statement reads. Only `_id` and `email` are kept. */
export const EMAIL_CANONICAL_SCAN_ROWS = 1000;

/** Scan statements one run may send. A run that reads them all without reaching the end checks only what it read. */
export const EMAIL_CANONICAL_SCAN_PAGES = 8;

/** Rows one run fills. */
export const EMAIL_CANONICAL_BATCH = 8;

/**
 * D1 statements one fill costs: the conditional patch reads the row and writes it, and the audit trigger inserts its
 * `documentHistory` row. A run sends at most {@link EMAIL_CANONICAL_SCAN_PAGES} + 1 + 8 × 3 = 33 of the 50 a Worker
 * invocation may send on the Free plan; the rest covers the patch's retry rounds on contention (`lunora-upstream.md`).
 */
export const EMAIL_CANONICAL_FILL_STATEMENTS = 3;

export interface EmailCanonicalBackfillResult {
    /** Addresses that two or more rows fold to (scanned rows, or a scanned row and an existing holder). */
    conflicts: number;
    /** Rows this run filled. */
    filled: number;
    /** Unfilled rows the scan saw that this run did not fill. */
    remaining: number;
    /** `done`: no unfilled row is left; `progress`: call again; `conflict`: nothing more is written until it is resolved. */
    status: "conflict" | "done" | "progress";
}

interface UnfilledRow {
    _id: string;
    email: string;
}

/** Every unfilled row, up to the scan's budget, read from the primary so a row filled a moment ago is not seen again. */
const scanUnfilled = async (ctx: Pick<MutationCtx, "db">): Promise<UnfilledRow[]> => {
    const rows: UnfilledRow[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < EMAIL_CANONICAL_SCAN_PAGES; page += 1) {
        const result = await ctx.db.user.findMany({
            consistency: "primary",
            cursor,
            limit: EMAIL_CANONICAL_SCAN_ROWS,
            where: { emailCanonical: { isNull: true } },
        });

        for (const row of result.page) {
            rows.push({ _id: row._id as string, email: row.email });
        }

        if (result.isDone || result.continueCursor === undefined || result.continueCursor === null) {
            break;
        }

        cursor = result.continueCursor;
    }

    return rows;
};

/** How many canonical addresses more than one of `rows` folds to. */
const foldedDuplicates = (rows: ReadonlyArray<UnfilledRow>): number => {
    const seen = new Map<string, number>();

    for (const row of rows) {
        const canonical = canonicalEmail(row.email);

        seen.set(canonical, (seen.get(canonical) ?? 0) + 1);
    }

    return [...seen.values()].filter((count) => count > 1).length;
};

/**
 * Fills one batch. Checks every scanned row against the others and the batch against the rows that already hold a
 * canonical address before the first write, because `.global()` statements run without a transaction: a unique-index
 * failure halfway through would leave the first row of a pair filled, which is the pick this refuses to make.
 */
export const backfillEmailCanonicalBatch = async (ctx: Pick<MutationCtx, "db">): Promise<EmailCanonicalBackfillResult> => {
    const unfilled = await scanUnfilled(ctx);

    if (unfilled.length === 0) {
        return { conflicts: 0, filled: 0, remaining: 0, status: "done" };
    }

    const scanned = foldedDuplicates(unfilled);

    if (scanned > 0) {
        return { conflicts: scanned, filled: 0, remaining: unfilled.length, status: "conflict" };
    }

    const batch = unfilled.slice(0, EMAIL_CANONICAL_BATCH).map((row) => {
        return { ...row, canonical: canonicalEmail(row.email) };
    });
    const { page: holders } = await ctx.db.user.findMany({
        consistency: "primary",
        limit: batch.length,
        where: { emailCanonical: { in: batch.map((row) => row.canonical) } },
    });

    if (holders.length > 0) {
        return { conflicts: holders.length, filled: 0, remaining: unfilled.length, status: "conflict" };
    }

    let filled = 0;

    for (const row of batch) {
        try {
            // Only while the row is still unfilled and still has the address the canonical was computed from: a sign-in
            // that changed it in between leaves the row for the next run.
            const { applied } = await ctx.db.patchIf("user", row._id as never, {
                patch: { emailCanonical: row.canonical },
                where: { email: row.email, emailCanonical: null },
            });

            filled += applied ? 1 : 0;
        } catch (error) {
            // A sign-up that took this address since the check: the unique index refused the write.
            const holder = await ctx.db.user.findFirst({ consistency: "primary", where: { emailCanonical: row.canonical } });

            if (holder === null) {
                throw error;
            }

            return { conflicts: 1, filled, remaining: unfilled.length - filled, status: "conflict" };
        }
    }

    const remaining = unfilled.length - filled;

    return { conflicts: 0, filled, remaining, status: remaining === 0 ? "done" : "progress" };
};

export const backfillEmailCanonical = internalMutation
    .input({})
    .output(
        v.object({
            conflicts: v.number(),
            filled: v.number(),
            remaining: v.number(),
            status: v.union(v.literal("conflict"), v.literal("done"), v.literal("progress")),
        }),
    )
    .mutation(async ({ ctx }) => await backfillEmailCanonicalBatch(ctx));

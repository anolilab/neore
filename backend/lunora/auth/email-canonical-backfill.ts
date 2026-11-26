/**
 * Fills `user.emailCanonical` on the rows that predate the column, with the `canonicalEmail` the auth plugin computes for a new
 * sign-up. `@lunora/auth` relies on the column's unique index to refuse a concurrent sign-up that repeats a folded address, and
 * the Worker never runs the plugin's own backfill (`ensureMigrated` is not called, see `src/server.ts`).
 *
 * `user` is a `.global()` D1 table, so a `defineMigration` cannot do this: it runs in each shard's Durable Object against
 * that shard's SQLite and never reaches D1. `canonicalEmail` folds Unicode (NFC, then a Unicode lower case), which SQLite's
 * `lower()` does not, so a SQL `UPDATE` cannot either. The deploy calls this through `POST /admin/backfill-email-canonical`
 * (`email-canonical-backfill-http.ts`, `scripts/data-migrations.ts#runEmailCanonicalBackfill`) in two phases:
 *
 * 1. **check**: every user row, filled or not, page by page from a cursor the caller carries. Each call answers a salted
 *    digest of each row's canonical address, so the caller sees a pair that two calls split; a pair inside one call is
 *    refused here. Nothing is written. `.global()` writes are not transactional, so no account is filled before the whole
 *    table is known to fold to distinct addresses: filling one row of a pair would pick it over the other.
 * 2. **fill**: the check also answers the ids of the unfilled rows it read; a fill call takes up to
 *    {@link EMAIL_CANONICAL_BATCH} of them and reads only those rows, by id. (Reading the next unfilled rows instead would
 *    sort every one still unfilled on each call: the `emailCanonical` index finds them, not in creation order.) A row is
 *    filled only while it is still unfilled and unchanged since a moment before the check began
 *    ({@link EMAIL_CANONICAL_SETTLE_MS}); a row changed since is skipped, and the caller checks again from the start.
 *
 * A run with nothing left reads once and writes nothing. Two rows that fold to one address are never resolved here: merge or
 * rename one of them, then deploy again.
 */
import { canonicalEmail } from "@lunora/auth";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";

/** D1 statements one Worker invocation may send on the Free plan. */
const INVOCATION_D1_QUERIES = 50;

/** Rows one check statement reads. */
export const EMAIL_CANONICAL_CHECK_ROWS = 1000;

/** Check statements one call sends; with the call's first read, 9 of the 50. */
export const EMAIL_CANONICAL_CHECK_PAGES = 8;

/** Rows one fill call reads and tries to fill. */
export const EMAIL_CANONICAL_BATCH = 8;

/**
 * D1 statements one fill costs uncontended: the conditional patch reads the row and writes it, and the audit trigger
 * inserts its `documentHistory` row. A fill that loses a race to a write that changed the row costs a read more and misses.
 */
export const EMAIL_CANONICAL_FILL_STATEMENTS = 3;

/**
 * Statements one fill call plans for: the read of its rows by id, the holder check and {@link EMAIL_CANONICAL_BATCH} fills. The rest
 * of the 50 is headroom for the conditional patch's retry rounds (two statements each), which it neither caps nor reports
 * (`docs/agents/lunora-upstream.md`): a round repeats only after a write that left the row's `email`, `emailCanonical` and
 * `updatedAt` as they were, and the call stops after the first fill that shows one.
 */
export const EMAIL_CANONICAL_FILL_PLAN = 2 + EMAIL_CANONICAL_BATCH * EMAIL_CANONICAL_FILL_STATEMENTS;

/** Retry rounds the headroom pays for inside the one contended fill a call allows. */
export const EMAIL_CANONICAL_RETRY_HEADROOM = Math.floor((INVOCATION_D1_QUERIES - EMAIL_CANONICAL_FILL_PLAN - 1) / 2);

/**
 * How long before a check began a row's last change must lie for a fill to trust the check's read of it. A Worker's clock
 * stands still between its I/O, so a write that commits after the check read the row can carry an `updatedAt` from
 * before the check began; a request that takes longer than this between its clock read and its write is not covered.
 */
export const EMAIL_CANONICAL_SETTLE_MS = 60_000;

/** Bytes of a canonical address's SHA-256 a check answers: 128 bits, so two distinct addresses never meet by chance. */
const DIGEST_BYTES = 16;

export type EmailCanonicalCheckResult =
    | {
          /** Addresses two rows of this call fold to. Nothing is answered but the count. */
          conflicts: number;
          status: "conflict";
      }
    | {
          /** When this call began; a fill trusts only rows unchanged since {@link EMAIL_CANONICAL_SETTLE_MS} before the first. */
          checkedAt: number;
          /** Where the next call goes on; absent once the scan reached the end (`checked`). */
          cursor?: string;
          /** A salted digest of each scanned row's canonical address. */
          digests: string[];
          /** Rows this call read. */
          scanned: number;
          status: "checked" | "checking";
          /** The ids of the scanned rows still unfilled, in creation order: what the fill takes. */
          unfilledIds: Id<"user">[];
      }
    | {
          /** No unfilled row is left. */
          status: "done";
      };

export interface EmailCanonicalFillResult {
    /** Addresses an existing account holds that a row of this batch folds to; with `conflict`. */
    conflicts: number;
    filled: number;
    /** How many of the call's ids, from the first, it is done with; the caller passes the rest again. */
    processed: number;
    /** Rows of this batch left unfilled because they changed since the check, or lost a race to a write. */
    skipped: number;
    /** `progress`: call again with the ids not processed, then the next ones; `conflict`: nothing more is written. */
    status: "conflict" | "progress";
}

export interface EmailCanonicalCheckOptions {
    cursor?: string;
    pageRows?: number;
    pages?: number;
    /** The caller's per-check salt: the digests mean nothing without it. */
    salt: string;
}

export interface EmailCanonicalFillOptions {
    /** `checkedAt` from the first call of the check this fill follows. */
    checkedAt: number;
    /** Up to {@link EMAIL_CANONICAL_BATCH} ids from the check's `unfilledIds`. */
    ids: ReadonlyArray<Id<"user">>;
}

const toHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const digestOf = async (salt: string, canonical: string): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\u{0}${canonical}`));

    return toHex(new Uint8Array(hash).slice(0, DIGEST_BYTES));
};

/** One check call: a page run over every user row, filled or not, from `cursor`. Writes nothing. */
export const checkEmailCanonicalPage = async (
    ctx: Pick<MutationCtx, "db" | "now">,
    { cursor, pageRows = EMAIL_CANONICAL_CHECK_ROWS, pages = EMAIL_CANONICAL_CHECK_PAGES, salt }: EmailCanonicalCheckOptions,
): Promise<EmailCanonicalCheckResult> => {
    if (cursor === undefined) {
        const { page } = await ctx.db.user.findMany({ consistency: "primary", limit: 1, where: { emailCanonical: { isNull: true } } });

        if (page.length === 0) {
            return { status: "done" };
        }
    }

    const counts = new Map<string, number>();
    let next: string | undefined = cursor;
    let reachedEnd = false;
    const unfilledIds: Id<"user">[] = [];

    for (let page = 0; page < pages && !reachedEnd; page += 1) {
        const result = await ctx.db.user.findMany({ consistency: "primary", cursor: next, limit: pageRows });

        for (const row of result.page) {
            const canonical = row.emailCanonical ?? canonicalEmail(row.email);

            if ((row.emailCanonical ?? undefined) === undefined) {
                unfilledIds.push(row._id);
            }

            counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
        }

        reachedEnd = result.isDone || !result.continueCursor;
        next = reachedEnd ? undefined : (result.continueCursor ?? undefined);
    }

    const conflicts = [...counts.values()].filter((count) => count > 1).length;

    if (conflicts > 0) {
        return { conflicts, status: "conflict" };
    }

    const digests = await Promise.all([...counts.keys()].map(async (canonical) => await digestOf(salt, canonical)));

    return {
        checkedAt: ctx.now,
        digests,
        scanned: counts.size,
        status: reachedEnd ? "checked" : "checking",
        unfilledIds,
        ...(next !== undefined && { cursor: next }),
    };
};

/** Whether the row a fill wrote differs from the batch's read of it in anything but the column the fill set. */
const changedSinceRead = (read: Record<string, unknown>, written: Record<string, unknown> | null): boolean => {
    if (written === null) {
        return false;
    }

    const keys = new Set([...Object.keys(read), ...Object.keys(written)]);

    keys.delete("emailCanonical");

    return [...keys].some((key) => JSON.stringify(read[key]) !== JSON.stringify(written[key]));
};

/** One fill call: the rows `ids` names, in that order. */
export const fillEmailCanonicalBatch = async (
    ctx: Pick<MutationCtx, "db">,
    { checkedAt, ids }: EmailCanonicalFillOptions,
): Promise<EmailCanonicalFillResult> => {
    if (ids.length > EMAIL_CANONICAL_BATCH) {
        throw new LunoraError("BAD_REQUEST", `A fill takes at most ${String(EMAIL_CANONICAL_BATCH)} ids`);
    }

    const { page } = await ctx.db.user.findMany({ consistency: "primary", limit: ids.length, where: { _id: { in: [...ids] } } });
    const byId = new Map(page.map((row) => [row._id, row]));
    const settledBefore = checkedAt - EMAIL_CANONICAL_SETTLE_MS;
    // A row filled meanwhile (or deleted) needs nothing; one changed since the check began waits for the next check.
    const unfilled = ids.flatMap((id) => {
        const row = byId.get(id);

        return row === undefined || (row.emailCanonical ?? undefined) !== undefined ? [] : [{ canonical: canonicalEmail(row.email), id, row }];
    });
    const settled = unfilled.filter(({ row }) => row.updatedAt <= settledBefore);
    let skipped = unfilled.length - settled.length;

    if (settled.length > 0) {
        const { page: holders } = await ctx.db.user.findMany({
            consistency: "primary",
            limit: settled.length,
            where: { emailCanonical: { in: settled.map(({ canonical }) => canonical) } },
        });

        if (holders.length > 0) {
            return { conflicts: holders.length, filled: 0, processed: 0, skipped: 0, status: "conflict" };
        }
    }

    let filled = 0;

    for (const { canonical, id, row } of settled) {
        let outcome: { applied: boolean; doc: Record<string, unknown> | null };

        try {
            // Only while the row is still unfilled and unchanged since this call read it: any write in between that moves
            // `updatedAt` makes this miss after one read more, and the row waits for the next check.
            outcome = await ctx.db.patchIf("user", id, {
                patch: { emailCanonical: canonical },
                where: { email: row.email, emailCanonical: null, updatedAt: row.updatedAt },
            });
        } catch (error) {
            // A sign-up that took this address since the check: the unique index refused the write. Anything else (the
            // audit insert, the network, the conditional patch's own `occ`) is not a conflict and is not swallowed.
            const holder = await ctx.db.user.findFirst({ consistency: "primary", where: { emailCanonical: canonical } });

            if (holder === null || holder._id === id) {
                throw error;
            }

            return { conflicts: 1, filled, processed: 0, skipped, status: "conflict" };
        }

        if (outcome.applied) {
            filled += 1;
        } else {
            skipped += 1;
        }

        // A fill that wrote a row other writes changed in between went round at least once more, and nothing says how often.
        // Stop the call; the caller passes the ids after this one again.
        if (outcome.applied && changedSinceRead({ ...row }, outcome.doc)) {
            return { conflicts: 0, filled, processed: ids.indexOf(id) + 1, skipped, status: "progress" };
        }
    }

    return { conflicts: 0, filled, processed: ids.length, skipped, status: "progress" };
};

export const checkEmailCanonical = internalMutation
    .input({ cursor: v.optional(v.string().max(MAX_LENGTH.cursor)), salt: v.string().max(MAX_LENGTH.id) })
    .output(
        v.union(
            v.object({ conflicts: v.number(), status: v.literal("conflict") }),
            v.object({
                checkedAt: v.number(),
                cursor: v.optional(v.string()),
                digests: v.array(v.string()),
                scanned: v.number(),
                status: v.union(v.literal("checked"), v.literal("checking")),
                unfilledIds: v.array(v.id("user")),
            }),
            v.object({ status: v.literal("done") }),
        ),
    )
    .mutation(async ({ args, ctx }) => await checkEmailCanonicalPage(ctx, { cursor: args.cursor, salt: args.salt }));

export const fillEmailCanonical = internalMutation
    .input({ checkedAt: v.number(), ids: v.array(v.id("user")).max(EMAIL_CANONICAL_BATCH) })
    .output(
        v.object({
            conflicts: v.number(),
            filled: v.number(),
            processed: v.number(),
            skipped: v.number(),
            status: v.union(v.literal("conflict"), v.literal("progress")),
        }),
    )
    .mutation(async ({ args, ctx }) => await fillEmailCanonicalBatch(ctx, { checkedAt: args.checkedAt, ids: args.ids }));

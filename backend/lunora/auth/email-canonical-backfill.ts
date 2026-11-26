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
 * 1. **check**: every user row, filled or not, page by page. The first call opens a check record (an `idempotencyClaims`
 *    row on the root shard, keyed by a token this server makes) holding the check's start, the next cursor, a digest of
 *    each folded address read so far and the ids of the unfilled rows. Each later call names the token and goes on from
 *    the record's cursor, so no page is skipped or read twice. An address two rows fold to, in one call or across calls,
 *    is refused and the record dropped. Nothing is written to `user`. `.global()` writes are not transactional, so no
 *    account is filled before the whole table is known to fold to distinct addresses: filling one row of a pair would
 *    pick it over the other.
 * 2. **fill**: takes the token of a COMPLETED check and {@link EMAIL_CANONICAL_BATCH} of the ids that check recorded,
 *    and reads only that row, by id. The check's start comes from the record, never from the caller. A row is filled
 *    only while it is still unfilled and unchanged since a moment before the check began ({@link EMAIL_CANONICAL_SETTLE_MS});
 *    a row changed since is skipped, and the caller checks again from the start.
 *
 * A run with nothing left reads once and writes nothing. Two rows that fold to one address are never resolved here: merge or
 * rename one of them, then deploy again.
 */
import { canonicalEmail } from "@lunora/auth";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { claimFence, claimRow, recordClaimResult, releaseClaim } from "../lib/claim-once";
import { MAX_LENGTH } from "../lib/validators";

/** D1 statements one Worker invocation may send on the Free plan. */
export const INVOCATION_D1_QUERIES = 50;

/** Rows one D1 statement answers at most. */
export const D1_RESULT_ROWS = 1000;

/**
 * Rows one check statement reads. Lunora's `findMany` fetches one row more than its `limit` to tell whether a page is
 * the last (`@lunora/shard-engine`'s `composeReadPredicate`), so a page of {@link D1_RESULT_ROWS} would ask for a row the
 * statement cannot answer, and a full last page would read as the end of the table.
 */
export const EMAIL_CANONICAL_CHECK_ROWS = 500;

/** Check statements one call sends; with a fresh check's first read, 17 of the 50. */
export const EMAIL_CANONICAL_CHECK_PAGES = 16;

/**
 * Ids one fill call takes. A conditional patch (`ctx.db.patchIf`) goes round up to {@link PATCH_IF_ATTEMPTS} times, a read
 * and a guarded write each, and takes no lower cap; two of them at their worst would pass the 50 statements.
 */
export const EMAIL_CANONICAL_BATCH = 1;

/** Rounds `ctx.db.patchIf` makes before it throws `occ` (Lunora's `sql-store`, not configurable). */
export const PATCH_IF_ATTEMPTS = 16;

/**
 * D1 statements one fill call may send at worst: the read of its row by id, the holder check, every round of the
 * conditional patch, the audit trigger's `documentHistory` insert and the holder lookup after a refused write.
 */
export const EMAIL_CANONICAL_FILL_WORST = 2 + EMAIL_CANONICAL_BATCH * (PATCH_IF_ATTEMPTS * 2 + 1) + 1;

/**
 * How long before a check began a row's last change must lie for a fill to trust the check's read of it. A Worker's clock
 * stands still between its I/O, so a write that commits after the check read the row can carry an `updatedAt` from
 * before the check began; a request that takes longer than this between its clock read and its write is not covered.
 */
export const EMAIL_CANONICAL_SETTLE_MS = 60_000;

/** The claim scope of a check record; its key is the check's token. */
export const EMAIL_CANONICAL_CHECK_SCOPE = "email-canonical-check";

/** How long a check record lasts: a run checks, fills and checks again well within it. */
export const EMAIL_CANONICAL_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** The longest check record kept: about 25,000 accounts. A larger table needs the record split before it can be checked. */
export const EMAIL_CANONICAL_RECORD_MAX_LENGTH = 1_500_000;

/** Bytes of a folded address's SHA-256 the record keeps: 64 bits, so two distinct addresses of one table never meet by chance. */
const DIGEST_BYTES = 8;

/** Bytes of a check token. */
const TOKEN_BYTES = 16;

export type EmailCanonicalCheckResult =
    | {
          /** Addresses two rows fold to. Nothing is answered but the count. */
          conflicts: number;
          status: "conflict";
      }
    | {
          /** Rows this call read. */
          scanned: number;
          /** `checked` once the whole table is read; `checking`: call again with the token. */
          status: "checked" | "checking";
          /** The check this call belongs to; a fill names it. */
          token: string;
          /** The ids of the rows this call read that are still unfilled, in creation order: what the fill takes. */
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
    /** `progress`: call again with the next ids; `conflict`: nothing more is written. */
    status: "conflict" | "progress";
}

export interface EmailCanonicalCheckOptions {
    pageRows?: number;
    pages?: number;
    /** The token a former call of this check answered; none starts a check. */
    token?: string;
}

export interface EmailCanonicalFillOptions {
    /** Up to {@link EMAIL_CANONICAL_BATCH} ids the check recorded. */
    ids: ReadonlyArray<Id<"user">>;
    /** The token of a completed check. */
    token: string;
}

/** What a check record holds, as JSON in its claim's `result`. */
interface CheckRecord {
    /** The next page's cursor; absent once the scan reached the end. */
    cursor?: string;
    /** Whether the scan reached the end with no address shared. */
    done: boolean;
    /** A digest of each folded address read, salted with the token. */
    folds: string[];
    /** The ids of the unfilled rows read. */
    ids: string[];
    /** `ctx.now` of the check's first call. */
    startedAt: number;
}

type BackfillCtx = Pick<MutationCtx, "db" | "now">;

const toHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const digestOf = async (token: string, canonical: string): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}\u{0}${canonical}`));

    return toHex(new Uint8Array(hash).slice(0, DIGEST_BYTES));
};

const isRecord = (value: unknown): value is CheckRecord => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;

    return (
        typeof record.startedAt === "number" &&
        typeof record.done === "boolean" &&
        Array.isArray(record.folds) &&
        Array.isArray(record.ids) &&
        (record.cursor === undefined || typeof record.cursor === "string")
    );
};

/** The unexpired check record under `token`, with the claim's `claimedAt` for a fenced update; `null` when there is none. */
const readRecord = async (ctx: BackfillCtx, token: string): Promise<{ claimedAt: number; record: CheckRecord } | null> => {
    const row = await claimRow(ctx, EMAIL_CANONICAL_CHECK_SCOPE, token);

    if (row?.result === undefined) {
        return null;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(row.result);
    } catch {
        return null;
    }

    return isRecord(parsed) ? { claimedAt: row.claimedAt, record: parsed } : null;
};

const saveRecord = async (ctx: BackfillCtx, token: string, claimedAt: number, record: CheckRecord): Promise<void> => {
    const json = JSON.stringify(record);

    if (json.length > EMAIL_CANONICAL_RECORD_MAX_LENGTH) {
        throw new LunoraError("BAD_REQUEST", "Too many accounts for one email-canonical check record");
    }

    if (!(await recordClaimResult(ctx, EMAIL_CANONICAL_CHECK_SCOPE, token, claimedAt, json))) {
        throw new LunoraError("BAD_REQUEST", "The email-canonical check record lapsed; start the check again");
    }
};

/**
 * One check call: up to `pages` pages over every user row, filled or not, from the record's cursor. Writes the check
 * record only, never a `user` row. Every row's key is the fold of its `email` as it is now, whatever its stored column
 * says, and also that stored value when it differs: the stored one is what the unique index holds.
 */
export const checkEmailCanonicalPage = async (
    ctx: BackfillCtx,
    { pageRows = EMAIL_CANONICAL_CHECK_ROWS, pages = EMAIL_CANONICAL_CHECK_PAGES, token: given }: EmailCanonicalCheckOptions = {},
): Promise<EmailCanonicalCheckResult> => {
    let token: string;
    let claimedAt: number;
    let record: CheckRecord;

    if (given === undefined) {
        const { page } = await ctx.db.user.findMany({ consistency: "primary", limit: 1, where: { emailCanonical: { isNull: true } } });

        if (page.length === 0) {
            return { status: "done" };
        }

        token = toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));

        const fence = await claimFence(ctx, EMAIL_CANONICAL_CHECK_SCOPE, token, { ttlMs: EMAIL_CANONICAL_CHECK_TTL_MS });

        if (fence === null) {
            throw new LunoraError("CONFLICT", "An email-canonical check token was handed out twice");
        }

        claimedAt = fence;
        record = { done: false, folds: [], ids: [], startedAt: ctx.now };
    } else {
        const held = await readRecord(ctx, given);

        if (held === null) {
            throw new LunoraError("BAD_REQUEST", "No email-canonical check under this token; start the check again");
        }

        if (held.record.done) {
            throw new LunoraError("BAD_REQUEST", "This email-canonical check is complete; fill from it or start a new one");
        }

        ({ claimedAt, record } = held);
        token = given;
    }

    const known = new Set(record.folds);
    const counts = new Map<string, number>();
    let next = record.cursor;
    let reachedEnd = false;
    let scanned = 0;
    const unfilledIds: Id<"user">[] = [];

    for (let page = 0; page < pages && !reachedEnd; page += 1) {
        const result = await ctx.db.user.findMany({ consistency: "primary", cursor: next, limit: pageRows });

        for (const row of result.page) {
            const stored = row.emailCanonical ?? undefined;
            const keys = new Set([canonicalEmail(row.email), ...(stored === undefined ? [] : [stored])]);

            if (stored === undefined) {
                unfilledIds.push(row._id);
            }

            for (const key of keys) {
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
        }

        scanned += result.page.length;
        reachedEnd = result.isDone || !result.continueCursor;
        next = reachedEnd ? undefined : (result.continueCursor ?? undefined);
    }

    const digests = new Map(await Promise.all([...counts.keys()].map(async (key) => [key, await digestOf(token, key)] as const)));
    const conflicts = [...counts].filter(([key, count]) => count > 1 || known.has(digests.get(key)!)).length;

    if (conflicts > 0) {
        await releaseClaim(ctx, EMAIL_CANONICAL_CHECK_SCOPE, token, claimedAt);

        return { conflicts, status: "conflict" };
    }

    await saveRecord(ctx, token, claimedAt, {
        done: reachedEnd,
        folds: [...record.folds, ...digests.values()],
        ids: [...record.ids, ...unfilledIds],
        startedAt: record.startedAt,
        ...(next !== undefined && { cursor: next }),
    });

    return { scanned, status: reachedEnd ? "checked" : "checking", token, unfilledIds };
};

/** One fill call: the rows `ids` names, from the completed check `token` recorded. */
export const fillEmailCanonicalBatch = async (ctx: BackfillCtx, { ids, token }: EmailCanonicalFillOptions): Promise<EmailCanonicalFillResult> => {
    if (ids.length > EMAIL_CANONICAL_BATCH) {
        throw new LunoraError("BAD_REQUEST", `A fill takes at most ${String(EMAIL_CANONICAL_BATCH)} id(s)`);
    }

    const held = await readRecord(ctx, token);

    if (held === null || !held.record.done) {
        throw new LunoraError("BAD_REQUEST", "A fill needs a completed email-canonical check");
    }

    const { ids: approved, startedAt } = held.record;

    if (!Number.isSafeInteger(startedAt) || startedAt > ctx.now) {
        throw new LunoraError("BAD_REQUEST", "The email-canonical check's start time is not in the past");
    }

    const approvedIds = new Set(approved);

    if (ids.some((id) => !approvedIds.has(id))) {
        throw new LunoraError("BAD_REQUEST", "A fill takes only ids its check recorded");
    }

    if (ids.length === 0) {
        return { conflicts: 0, filled: 0, processed: 0, skipped: 0, status: "progress" };
    }

    const { page } = await ctx.db.user.findMany({ consistency: "primary", limit: ids.length, where: { _id: { in: [...ids] } } });
    const byId = new Map(page.map((row) => [row._id, row]));
    const settledBefore = startedAt - EMAIL_CANONICAL_SETTLE_MS;
    // A row filled meanwhile (or deleted) needs nothing; one changed since the check began waits for the next check.
    const unfilled = ids.flatMap((id) => {
        const row = byId.get(id);

        return row === undefined || (row.emailCanonical ?? undefined) !== undefined ? [] : [{ canonical: canonicalEmail(row.email), id, row }];
    });
    const settled = unfilled.filter(({ row }) => row.updatedAt <= settledBefore);

    if (new Set(settled.map(({ canonical }) => canonical)).size < settled.length) {
        return { conflicts: 1, filled: 0, processed: 0, skipped: 0, status: "conflict" };
    }

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
        let applied: boolean;

        try {
            // Only while the row is still unfilled and unchanged since this call read it: a write in between that moves
            // `updatedAt` makes this miss after one read more, and the row waits for the next check.
            ({ applied } = await ctx.db.patchIf("user", id, {
                patch: { emailCanonical: canonical },
                where: { email: row.email, emailCanonical: null, updatedAt: row.updatedAt },
            }));
        } catch (error) {
            // A sign-up that took this address since the check: the unique index refused the write. Anything else (the
            // audit insert, the network, the conditional patch's own `occ`) is not a conflict and is not swallowed.
            const holder = await ctx.db.user.findFirst({ consistency: "primary", where: { emailCanonical: canonical } });

            if (holder === null || holder._id === id) {
                throw error;
            }

            return { conflicts: 1, filled, processed: 0, skipped, status: "conflict" };
        }

        if (applied) {
            filled += 1;
        } else {
            skipped += 1;
        }
    }

    return { conflicts: 0, filled, processed: ids.length, skipped, status: "progress" };
};

export const checkEmailCanonical = internalMutation
    .input({ token: v.optional(v.string().max(MAX_LENGTH.id)) })
    .output(
        v.union(
            v.object({ conflicts: v.number(), status: v.literal("conflict") }),
            v.object({
                scanned: v.number(),
                status: v.union(v.literal("checked"), v.literal("checking")),
                token: v.string(),
                unfilledIds: v.array(v.id("user")),
            }),
            v.object({ status: v.literal("done") }),
        ),
    )
    .mutation(async ({ args, ctx }) => await checkEmailCanonicalPage(ctx, { ...(args.token !== undefined && { token: args.token }) }));

export const fillEmailCanonical = internalMutation
    .input({ ids: v.array(v.id("user")).max(EMAIL_CANONICAL_BATCH), token: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            conflicts: v.number(),
            filled: v.number(),
            processed: v.number(),
            skipped: v.number(),
            status: v.union(v.literal("conflict"), v.literal("progress")),
        }),
    )
    .mutation(async ({ args, ctx }) => await fillEmailCanonicalBatch(ctx, { ids: args.ids, token: args.token }));

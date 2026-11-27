/**
 * An account whose pins are being moved or erased. A guest merge (`lib/account-merge.ts`) and an account erasure
 * (`gdpr/workflows/deletion-workflow.ts`) mark the account before they touch its pins; a pin write by a marked account is refused
 * (`chat/pins/functions.ts`), and so is a run webhook save or rotation (`run-webhooks/functions.ts`), which the merge copies before it
 * clears the guest's shard. The marker is global and read on the primary, so every shard sees a move that has started.
 *
 * A marker belongs to the operation that wrote it: a merge ends only its own marker, so an erasure that overlaps it keeps its fence.
 *
 * A pin write checks the marker and renews the account's lease. A refused write renews nothing, so a marked account's retries cannot hold
 * a move back. Every pin write checks the marker again right before its insert (`refusesPinWrite`, `chat/pins/functions.ts`). A write
 * that passed the check cannot commit unseen: the move waits until no lease is in flight (`pinWritesInFlightUntil`) before it sweeps.
 */
import { v } from "lunorash/server";

import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { MAX_LENGTH } from "./validators";

/**
 * The marker kinds. An erasure and a guest merge fence the account's pins; an importing marker only fences the erasure of the account a
 * merge imports rows into (the destination), so it does not block the destination's own pin writes.
 */
export type AccountMoveKind = "erasing" | "importing" | "merging";

/**
 * How long a pin write holds the account's lease. Longer than any pin mutation runs, so a lease that has run out has nothing left in
 * flight.
 */
export const PIN_WRITE_LEASE_MS = 60_000;

/** Expired lease rows a move's end or its reclaim call deletes at most. Each delete is two global statements, so 20 is 40. */
const LEASE_RECLAIM_BATCH = 20;

/**
 * Expired lease rows one pin admission deletes at most. An admission runs inside a pin write, which may also refuse and clean up its
 * routes, so it keeps to 10 (20 statements); the rest are reclaimed by later admissions. Worst case for a refused write is in
 * `chat/pins/functions.ts` (`REFUSED_WRITE_WORST`).
 */
export const ADMISSION_RECLAIM_BATCH = 10;

/**
 * Every lease row of the account. Lunora returns a read one page at a time, so a lease past the first page is read too: a missed writer
 * could let a refused write take back a route it still needs, or let an erasure sweep before that write commits.
 */
const leasesOf = async (context: Pick<QueryCtx, "db">, userId: string) => {
    const leases = [];
    let result = await context.db.pinWriteLeases.findMany({ consistency: "primary", where: { userId } });

    leases.push(...result.page);

    while (!result.isDone) {
        result = await context.db.pinWriteLeases.findMany({ consistency: "primary", cursor: result.continueCursor ?? undefined, where: { userId } });
        leases.push(...result.page);
    }

    return leases;
};

/** Whether the account's pins are being moved or erased right now. */
export const isAccountMoving = async (context: Pick<QueryCtx, "db">, userId: string, now: number): Promise<boolean> => {
    const { page } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    return page.some((row) => row.kind !== "importing" && isLiveMarker(row, now));
};

/**
 * How long a guest merge's marker fences the account. A merge that fails and is given up on leaves its marker; past this age the marker
 * stops blocking, so the account can pin again and its erasure can run. It is well past the merge's retry window and lease deferrals.
 */
export const MERGE_MARKER_MAX_AGE_MS = 60 * 60 * 1000;

/** Whether a marker still fences its account: an erasure always does; a merge does until it is too old to be a live merge. */
const isLiveMarker = (row: { createdAt: number; kind: AccountMoveKind }, now: number): boolean =>
    row.kind === "erasing" || row.createdAt > now - MERGE_MARKER_MAX_AGE_MS;

/**
 * Marks the account as moving for one operation. Idempotent for that operation: a retry or a redelivery keeps its one marker, renewed, so a
 * move that runs over several jobs (a guest merge marks again at each run) stays live past {@link MERGE_MARKER_MAX_AGE_MS}. Another
 * operation's marker is left alone, so an overlapping move adds its own.
 */
export const beginAccountMove = async (context: Pick<MutationCtx, "db">, userId: string, kind: AccountMoveKind, now: number): Promise<void> => {
    const { page } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    const marker = page.find((row) => row.kind === kind);

    if (marker === undefined) {
        await context.db.insert("accountMoves", { createdAt: now, kind, userId });

        return;
    }

    // A stale marker no longer fences the account: renewing it fences again. A live one is renewed so it does not lapse mid-move.
    if (marker.createdAt < now) {
        await context.db.patch("accountMoves", marker._id, { createdAt: now });
    }
};

/**
 * Adds the lease of one admitted pin write, and returns its writer id. Each write has its own row, which the move's wait reads until it
 * expires, and which a refused write's route cleanup reads to see whether another write is still in flight. Rows the account's earlier
 * writes left past their expiry are reclaimed here, a batch per admission, so one admission's writes stay within its budget.
 */
export const admitPinWrite = async (context: Pick<MutationCtx, "db">, userId: string, now: number): Promise<string> => {
    const writerId = crypto.randomUUID();
    const leases = await leasesOf(context, userId);
    let reclaimed = 0;

    for (const lease of leases) {
        if (lease.expiresAt > now || reclaimed >= ADMISSION_RECLAIM_BATCH) {
            continue;
        }

        await context.db.delete("pinWriteLeases", lease._id);
        reclaimed += 1;
    }

    await context.db.insert("pinWriteLeases", { expiresAt: now + PIN_WRITE_LEASE_MS, userId, writerId });

    return writerId;
};

/**
 * Admits a pin write: checks the marker once, then adds its lease. Returns the writer id, or null when the account is moving, in which
 * case the write is refused and adds no lease. An admitted write is not yet safe: it must call `refusesPinWrite` again as the last step
 * before its insert, after its route write (`chat/pins/functions.ts`).
 */
export const admitPinWriteAs = async (context: MutationCtx, userId: string, now: number): Promise<string | null> => {
    if (await refusesPinWrite(context, userId, now)) {
        return null;
    }

    return await admitPinWrite(context, userId, now);
};

/** Whether the account's refused write may take back a route: no other admitted pin write of the account can still be in flight. */
export const otherPinWritesInFlight = async (context: Pick<QueryCtx, "db">, userId: string, writerId: string | null, now: number): Promise<boolean> => {
    const leases = await leasesOf(context, userId);

    return leases.some((lease) => lease.expiresAt > now && lease.writerId !== writerId);
};

/** Removes one admitted write's own lease, so the refused write does not hold back its own cleanup. */
export const releasePinWrite = async (context: Pick<MutationCtx, "db">, userId: string, writerId: string): Promise<void> => {
    const leases = await leasesOf(context, userId);

    for (const lease of leases) {
        if (lease.writerId === writerId) {
            await context.db.delete("pinWriteLeases", lease._id);
        }
    }
};

/**
 * Whether a pin write of the account must be refused on this shard: a move is marking it, or this shard is fenced by an erasure. A
 * pin write calls it once before it renews its lease, and again as the last step before its insert (`chat/pins/functions.ts`).
 *
 * The last call names the write (`writerId`). It is refused too when that write's own lease is no longer live, or when the account row is
 * gone. A move can finish between a write's first check and its insert, and a finished move leaves no marker and no live lease for this
 * check to see. The account row is what outlives it: the guest's row goes only when its merge or erasure ends it (`auth/hooks.ts`), as a
 * grant written under a deleted account is refused (`agent/sharing.ts`). Both reads are on the primary.
 */
export const refusesPinWrite = async (context: Pick<QueryCtx, "db">, userId: string, now: number, writerId: string | null = null): Promise<boolean> => {
    if ((await isAccountMoving(context, userId, now)) || (await isShardFenced(context, userId))) {
        return true;
    }

    if (writerId === null) {
        return false;
    }

    const account = await context.db.user.findFirst({ consistency: "primary", where: { _id: context.db.asId("user", userId) } });

    if (account === null) {
        return true;
    }

    const leases = await leasesOf(context, userId);
    // The wall clock, whatever `now` the caller started with: a write that stalled past its lease must see that lease as expired.
    const current = Date.now();

    return leases.every((lease) => lease.writerId !== writerId || lease.expiresAt <= current);
};

/**
 * The latest moment a pin write of the account may still be in flight, or null when none can be. A move waits until that moment (an
 * erasure) or re-enqueues itself for it (a guest merge).
 */
export const pinWritesInFlightUntil = async (context: Pick<QueryCtx, "db">, userId: string, now: number): Promise<number | null> => {
    const leases = await leasesOf(context, userId);
    let latest = 0;

    for (const lease of leases) {
        latest = lease.expiresAt > now && lease.expiresAt > latest ? lease.expiresAt : latest;
    }

    return latest > 0 ? latest : null;
};

/**
 * Removes the operation's marker once its move is finished. The leases go with the last marker: while another move is still running
 * its fence holds. Both name the account, so they must not outlive the moves.
 */
export const endAccountMove = async (context: Pick<MutationCtx, "db">, userId: string, kind: AccountMoveKind): Promise<void> => {
    const { page: moves } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    for (const row of moves) {
        // An erasure ends the account, so every marker of it goes, a stale merge's too. A merge ends only its own.
        if (kind === "erasing" || row.kind === kind) {
            await context.db.delete("accountMoves", row._id);
        }
    }

    // An importing marker is the destination's: its leases are the destination's own pin writes, still in flight, so they stay.
    if (kind === "importing") {
        return;
    }

    if (kind !== "erasing" && moves.some((row) => row.kind !== kind)) {
        return;
    }

    // The move waited for every live lease, so what is left is expired: a batch goes now, and admissions reclaim the rest.
    const leases = await leasesOf(context, userId);

    for (const row of leases.slice(0, LEASE_RECLAIM_BATCH)) {
        await context.db.delete("pinWriteLeases", row._id);
    }
};

/**
 * Deletes one batch of the account's lease rows and reports whether more may remain. The erasure repeats it after its marker goes, so
 * every row of the account is gone before the workflow completes (`gdpr/workflows/deletion-workflow.ts`). One page per call keeps each
 * call's writes bounded; the rows it removes are expired, since the move waited for every live lease.
 */
export const reclaimPinWriteLeases = async (context: Pick<MutationCtx, "db">, userId: string): Promise<boolean> => {
    const { isDone, page } = await context.db.pinWriteLeases.findMany({ consistency: "primary", limit: LEASE_RECLAIM_BATCH, where: { userId } });

    for (const row of page) {
        await context.db.delete("pinWriteLeases", row._id);
    }

    return !isDone;
};

/** Reclaims one batch of the account's leases, from the erasure's reclaim drain. Idempotent. */
export const reclaimPinWriteLeasesFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        return { hasMore: await reclaimPinWriteLeases(ctx, args.userId) };
    });

/** Removes the operation's marker, from a workflow or a job once its pins are moved or erased. Idempotent. */
export const endAccountMoveFor = internalMutation
    .input({ kind: v.union(v.literal("erasing"), v.literal("importing"), v.literal("merging")), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await endAccountMove(ctx, args.userId, args.kind);

        // An erasure also lifts the fence on the account's own shard. The owner shards' fences are lifted by the erasure's release step
        // (`gdpr/steps.ts#releasePinFences`), once both owner sweeps have run.
        if (args.kind === "erasing") {
            await unfencePinsOnShard(ctx, args.userId);
        }

        return null;
    });

/**
 * The latest moment the account's pin writes may still be in flight (null when none can be). A move calls it after it sets its marker.
 */
export const pinWritesInFlightFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ until: v.union(v.number(), v.null()) }))
    .mutation(async ({ args, ctx }) => {
        return { until: await pinWritesInFlightUntil(ctx, args.userId, ctx.now) };
    });

/** The marker, written from a workflow or a job before the account's pins are touched. */
export const beginAccountMoveFor = internalMutation
    .input({ kind: v.union(v.literal("erasing"), v.literal("importing"), v.literal("merging")), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await beginAccountMove(ctx, args.userId, args.kind, ctx.now);

        return null;
    });

/** Whether the account still holds a marker of `kind`, live or not: a finished guest merge checks that its own are gone. */
export const hasAccountMove = async (context: Pick<QueryCtx, "db">, userId: string, kind: AccountMoveKind): Promise<boolean> => {
    const { page } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    return page.some((row) => row.kind === kind);
};

/** Whether an erasure of the account is active. A guest merge checks it before it moves a pin: an erasure removes those pins. */
export const isErasing = async (context: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const { page } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    return page.some((row) => row.kind === "erasing");
};

/**
 * The latest moment an erasure must wait until before it sweeps the account's pins: the pin writes in flight, and a guest merge that is
 * still moving them (the erasure has priority once it is marked; a merge that finds it stops). Null when the erasure may sweep.
 */
export const eraseWaitUntil = async (context: Pick<QueryCtx, "db">, userId: string, now: number): Promise<number | null> => {
    const leaseUntil = await pinWritesInFlightUntil(context, userId, now);
    const { page } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    if (page.some((row) => (row.kind === "merging" || row.kind === "importing") && isLiveMarker(row, now))) {
        return Math.max(leaseUntil ?? 0, now + PIN_WRITE_LEASE_MS);
    }

    return leaseUntil;
};

/** Whether an erasure of the account is active, from a guest merge. */
export const isErasingFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ erasing: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        return { erasing: await isErasing(ctx, args.userId) };
    });

/** The latest moment an erasure waits until (null when it may sweep), from the erasure workflow. */
export const eraseWaitFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ until: v.union(v.number(), v.null()) }))
    .mutation(async ({ args, ctx }) => {
        return { until: await eraseWaitUntil(ctx, args.userId, ctx.now) };
    });

/**
 * Whether this shard fences the account's pin writes. Read inside the pin write's own transaction, on the shard the write runs on, so a
 * fence set by a sweep of this shard is seen by every write that commits after it.
 */
export const isShardFenced = async (context: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const rows = await context.db
        .query("shardPinFences")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(1);

    return rows.length > 0;
};

/** Fences the account's pin writes on this shard. Idempotent. */
export const fencePinsOnShard = async (context: Pick<MutationCtx, "db">, userId: string, now: number): Promise<void> => {
    const rows = await context.db
        .query("shardPinFences")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(1);

    if (rows.length === 0) {
        await context.db.insert("shardPinFences", { createdAt: now, userId });
    }
};

/** Lifts the account's fence on this shard. Idempotent. */
export const unfencePinsOnShard = async (context: Pick<MutationCtx, "db">, userId: string): Promise<void> => {
    const rows = await context.db
        .query("shardPinFences")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(100);

    for (const row of rows) {
        await context.db.delete("shardPinFences", row._id);
    }
};

/** Fences the account's pin writes on the shard the call runs on, from a sweep (`gdpr/steps.ts`) or the erasure workflow. */
export const fencePinsOnShardFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await fencePinsOnShard(ctx, args.userId, ctx.now);

        return null;
    });

/** Lifts the account's fence on the shard the call runs on, once the erasure no longer needs that shard fenced. */
export const unfencePinsOnShardFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await unfencePinsOnShard(ctx, args.userId);

        return null;
    });

/**
 * An account whose pins are being moved or erased. A guest merge (`lib/account-merge.ts`) and an account erasure
 * (`gdpr/workflows/deletion-workflow.ts`) mark the account before they touch its pins; a pin write by a marked account is refused
 * (`chat/pins/functions.ts`). The marker is global and read on the primary, so every shard sees a move that has started.
 *
 * A marker belongs to the operation that wrote it: a merge ends only its own marker, so an erasure that overlaps it keeps its fence.
 *
 * A pin write checks the marker, renews the account's lease, and checks the marker again. A refused write renews nothing, so a marked
 * account's retries cannot hold a move back. A write that passed the second check cannot commit unseen: the move waits until no lease
 * is in flight (`pinWritesInFlightUntil`) before it sweeps the pins.
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
 * Marks the account as moving for one operation. Idempotent for that operation: a retry or a redelivery leaves its marker in place. Another
 * operation's marker is left alone, so an overlapping move adds its own.
 */
export const beginAccountMove = async (context: Pick<MutationCtx, "db">, userId: string, kind: AccountMoveKind, now: number): Promise<void> => {
    const { page } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    const sameKind = page.filter((row) => row.kind === kind);

    if (sameKind.some((row) => isLiveMarker(row, now))) {
        return;
    }

    if (sameKind.length === 0) {
        await context.db.insert("accountMoves", { createdAt: now, kind, userId });

        return;
    }

    // A marker of this kind that has gone stale no longer fences the account: it is renewed, so a late delivery of the move fences again.
    await context.db.patch("accountMoves", sameKind[0]!._id, { createdAt: now });
};

/**
 * Renews the account's lease. The account has one lease row; a second one (two first writes at once) is harmless, since the wait reads
 * them all.
 */
export const admitPinWrite = async (context: Pick<MutationCtx, "db">, userId: string, now: number): Promise<void> => {
    const expiresAt = now + PIN_WRITE_LEASE_MS;
    const lease = await context.db.pinWriteLeases.findFirst({ consistency: "primary", where: { userId } });

    if (lease === null) {
        await context.db.insert("pinWriteLeases", { expiresAt, userId });
    } else if (lease.expiresAt < expiresAt) {
        await context.db.patch("pinWriteLeases", lease._id, { expiresAt });
    }
};

/**
 * Admits a pin write: checks the marker, renews the lease, checks the marker again. Returns whether the account is moving, in which case
 * the caller refuses the write. The second check closes the window where a move starts between the first check and the renewal.
 */
export const admitPinWriteUnlessMoving = async (context: MutationCtx, userId: string, now: number): Promise<boolean> => {
    if ((await isAccountMoving(context, userId, now)) || (await isShardFenced(context, userId))) {
        return true;
    }

    await admitPinWrite(context, userId, now);

    return (await isAccountMoving(context, userId, now)) || (await isShardFenced(context, userId));
};

/**
 * The latest moment a pin write of the account may still be in flight, or null when none can be. A move waits until that moment (an
 * erasure) or re-enqueues itself for it (a guest merge).
 */
export const pinWritesInFlightUntil = async (context: Pick<QueryCtx, "db">, userId: string, now: number): Promise<number | null> => {
    const { page } = await context.db.pinWriteLeases.findMany({ consistency: "primary", where: { userId } });
    let latest = 0;

    for (const lease of page) {
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

    const { page: leases } = await context.db.pinWriteLeases.findMany({ consistency: "primary", where: { userId } });

    for (const row of leases) {
        await context.db.delete("pinWriteLeases", row._id);
    }
};

/** Removes the operation's marker, from a workflow or a job once its pins are moved or erased. Idempotent. */
export const endAccountMoveFor = internalMutation
    .input({ kind: v.union(v.literal("erasing"), v.literal("importing"), v.literal("merging")), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await endAccountMove(ctx, args.userId, args.kind);

        // An erasure also lifts the fence on the account's own shard; the owner shards' fences are lifted by the sweep that set them.
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

/** Lifts the account's fence on the shard the call runs on, once the sweep that set it has finished. */
export const unfencePinsOnShardFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await unfencePinsOnShard(ctx, args.userId);

        return null;
    });

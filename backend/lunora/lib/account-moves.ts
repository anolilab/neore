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

export type AccountMoveKind = "erasing" | "merging";

/**
 * How long a pin write holds the account's lease. Longer than any pin mutation runs, so a lease that has run out has nothing left in
 * flight.
 */
export const PIN_WRITE_LEASE_MS = 60_000;

/** Whether the account's pins are being moved or erased right now. */
export const isAccountMoving = async (context: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const row = await context.db.accountMoves.findFirst({ consistency: "primary", where: { userId } });

    return row !== null;
};

/**
 * Marks the account as moving for one operation. Idempotent for that operation: a retry or a redelivery leaves its marker in place. Another
 * operation's marker is left alone, so an overlapping move adds its own.
 */
export const beginAccountMove = async (context: Pick<MutationCtx, "db">, userId: string, kind: AccountMoveKind, now: number): Promise<void> => {
    const { page } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    if (page.every((row) => row.kind !== kind)) {
        await context.db.insert("accountMoves", { createdAt: now, kind, userId });
    }
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
    if (await isAccountMoving(context, userId)) {
        return true;
    }

    await admitPinWrite(context, userId, now);

    return await isAccountMoving(context, userId);
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
        if (row.kind === kind) {
            await context.db.delete("accountMoves", row._id);
        }
    }

    if (moves.some((row) => row.kind !== kind)) {
        return;
    }

    const { page: leases } = await context.db.pinWriteLeases.findMany({ consistency: "primary", where: { userId } });

    for (const row of leases) {
        await context.db.delete("pinWriteLeases", row._id);
    }
};

/** Removes the operation's marker, from a workflow or a job once its pins are moved or erased. Idempotent. */
export const endAccountMoveFor = internalMutation
    .input({ kind: v.union(v.literal("erasing"), v.literal("merging")), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await endAccountMove(ctx, args.userId, args.kind);

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
    .input({ kind: v.union(v.literal("erasing"), v.literal("merging")), userId: v.string().max(MAX_LENGTH.id) })
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

    if (page.some((row) => row.kind === "merging")) {
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

/**
 * An account whose pins are being moved or erased. A guest merge (`lib/account-merge.ts`) and an account erasure
 * (`gdpr/workflows/deletion-workflow.ts`) mark the account before they touch its pins; a pin write by a marked account is refused
 * (`chat/pins/functions.ts`). The marker is global and read on the primary, so every shard sees a move that has started.
 *
 * A pin write first renews the account's lease, and only then checks the marker. A write that passed the check can therefore not
 * commit unseen: the move waits until no lease is in flight (`pinWritesInFlight`) before it sweeps the pins. A write that renewed its
 * lease after the marker was set sees the marker and is refused.
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

/** Marks the account as moving. Idempotent: a repeated call (a retry, a redelivery) leaves the first marker in place. */
export const beginAccountMove = async (context: Pick<MutationCtx, "db">, userId: string, kind: AccountMoveKind, now: number): Promise<void> => {
    const existing = await context.db.accountMoves.findFirst({ consistency: "primary", where: { userId } });

    if (!existing) {
        await context.db.insert("accountMoves", { createdAt: now, kind, userId });
    }
};

/**
 * Renews the account's lease before a pin write checks the marker, so a move that starts after the check waits for the write. The
 * account has one lease row; a second one (two first writes at once) is harmless, since the wait reads them all.
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

/** Whether a pin write of the account may still be in flight: one of its leases has not run out yet. */
export const pinWritesInFlight = async (context: Pick<QueryCtx, "db">, userId: string, now: number): Promise<boolean> => {
    const { page } = await context.db.pinWriteLeases.findMany({ consistency: "primary", where: { userId } });

    return page.some((lease) => lease.expiresAt > now);
};

/**
 * Removes the marker and the leases once the move is finished: the account's pins are moved or erased and its routes are gone. Both
 * name the account, so they must not outlive the move.
 */
export const endAccountMove = async (context: Pick<MutationCtx, "db">, userId: string): Promise<void> => {
    const { page: moves } = await context.db.accountMoves.findMany({ consistency: "primary", where: { userId } });

    for (const row of moves) {
        await context.db.delete("accountMoves", row._id);
    }

    const { page: leases } = await context.db.pinWriteLeases.findMany({ consistency: "primary", where: { userId } });

    for (const row of leases) {
        await context.db.delete("pinWriteLeases", row._id);
    }
};

/** Removes the marker and the leases, from a workflow or a job once the account's pins are moved or erased. Idempotent. */
export const endAccountMoveFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await endAccountMove(ctx, args.userId);

        return null;
    });

/**
 * Whether the account's pin writes may still be in flight. A move calls it after it sets the marker, and waits (an erasure) or fails
 * and is retried (a guest merge) while it answers yes.
 */
export const pinWritesInFlightFor = internalMutation
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ inFlight: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        return { inFlight: await pinWritesInFlight(ctx, args.userId, ctx.now) };
    });

/** The marker, written from a workflow or a job before the account's pins are touched. */
export const beginAccountMoveFor = internalMutation
    .input({ kind: v.union(v.literal("erasing"), v.literal("merging")), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await beginAccountMove(ctx, args.userId, args.kind, ctx.now);

        return null;
    });

/**
 * An account whose pins are being moved or erased. A guest merge (`lib/account-merge.ts`) and an account erasure
 * (`gdpr/workflows/deletion-workflow.ts`) mark the account before they touch its pins; a pin write by a marked account is refused
 * (`chat/pins/functions.ts`). The marker is global and read on the primary, so every shard sees a move that has started.
 */
import { v } from "lunorash/server";

import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { MAX_LENGTH } from "./validators";

export type AccountMoveKind = "erasing" | "merging";

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

/** The marker, written from a workflow or a job before the account's pins are touched. */
export const beginAccountMoveFor = internalMutation
    .input({ kind: v.union(v.literal("erasing"), v.literal("merging")), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await beginAccountMove(ctx, args.userId, args.kind, ctx.now);

        return null;
    });

/**
 * The owner-only passcode row of a locked thread, and the proof check that
 * admission (`thread-read-access.ts`) runs. Plain functions over `db`, so they
 * run in the caller's transaction and shard. Written only from here.
 */

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { systemDb } from "../lib/rls/scope";
import { isThreadLocked, type PasscodeHash, verifyUnlockProof } from "../lib/thread-lock";

type Db = QueryCtx["db"];

/** The signing secret for unlock proofs. Empty = no proofs can be minted or verified (fail closed). */
export const unlockSecret = (): string => process.env.STORAGE_SIGNING_SECRET ?? "";

export const readPasscodeRow = async (db: Pick<Db, "query">, threadId: Id<"threads">) =>
    db
        .query("threadPasscodes")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first();

export type PasscodeRow = NonNullable<Awaited<ReturnType<typeof readPasscodeRow>>>;

/** The hash fields `verifyPasscode` takes, from a stored row. */
export const passcodeHashOf = (row: PasscodeRow): PasscodeHash => {
    return { hash: row.hash, iterations: row.iterations, salt: row.salt };
};

/**
 * True when `proof` is a live proof for this thread, this owner and the row's
 * current epoch. A locked thread with no row fails closed.
 */
export const isUnlockProofValid = async (
    db: Pick<Db, "query">,
    thread: { _id: string },
    userId: string,
    proof: string | null | undefined,
    now: number,
): Promise<boolean> => {
    const row = await readPasscodeRow(db, thread._id as Id<"threads">);

    if (!row) {
        return false;
    }

    return verifyUnlockProof(proof, { epoch: row.epoch, threadId: thread._id, userId }, unlockSecret(), now);
};

/**
 * True when `threadId` is locked and `unlockProof` does not open it. The answer
 * for a system or handler reader, which SKIPS a locked thread rather than
 * refusing it. Reads the row past row-level security: a decision, never returned.
 */
export const isLockedWithoutProof = async (
    context: Pick<QueryCtx, "db">,
    threadId: Id<"threads">,
    unlockProof: string | null | undefined,
): Promise<boolean> => {
    const db = systemDb(context);
    const thread = await db.get(threadId);

    return !!thread && isThreadLocked(thread) && !(await isUnlockProofValid(db, thread, thread.userId ?? "", unlockProof, Date.now()));
};

/**
 * The one answer every chat path gives about a locked thread.
 *
 * - `ok` — the caller may use the thread at the level asked for.
 * - `locked` — the caller owns it, but the passcode proof is missing, stale or
 *   from an earlier epoch. Callers answer THREAD_LOCKED so the client can ask.
 * - `denied` — anything else, including every non-owner of a locked thread.
 *
 * Actions cannot read `ctx.db`, so they ask `internal.chat.functions.gateThreadAction`,
 * which calls {@link threadGateOutcome} and hands back the outcome.
 */

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../../_generated/server";
import { resolveThreadReadAccess, meetsThreadPermission, type ThreadPermission } from "../../agent/thread-read-access";
import { throwThreadNotFound, throwUnauthorized } from "../../lib/error-helpers";
import { isThreadLocked, throwThreadLocked, toLockedThreadStub } from "../../lib/thread-lock";

export type ThreadGateOutcome = "denied" | "locked" | "ok";

export interface ThreadGateArgs {
    level: ThreadPermission;
    threadId: Id<"threads">;
    unlockProof?: string | null;
    userId: string;
}

export const threadGateOutcome = async (context: Pick<QueryContext, "db">, args: ThreadGateArgs): Promise<ThreadGateOutcome> => {
    const access = await resolveThreadReadAccess(context, args.threadId, args.userId, args.unlockProof);

    if (access?.kind === "locked") {
        return "locked";
    }

    if (access?.kind !== "full" || !meetsThreadPermission(access.permission, args.level)) {
        return "denied";
    }

    return "ok";
};

/**
 * Throws THREAD_LOCKED for a locked thread and returns for `ok`. A denial is
 * UNAUTHORIZED with `deniedMessage`, or NOT_FOUND when none is given, so the
 * caller cannot tell a thread it may not reach from one that does not exist.
 */
export const throwUnlessGranted = (outcome: ThreadGateOutcome, deniedMessage?: string): void => {
    if (outcome === "locked") {
        throwThreadLocked();
    } else if (outcome === "denied") {
        if (deniedMessage === undefined) {
            throwThreadNotFound();
        }

        throwUnauthorized(deniedMessage);
    }
};

/**
 * True when the thread was locked AFTER a row was created. Every request that
 * writes into a locked thread must first verify the passcode proof, so a row
 * created after the lock was written under a proof; a lock newer than the row
 * means the proof that started the row predates the lock, and nothing may
 * continue on it. Used for stream rows (`createStreamWithMessage` runs only after
 * the gate) and for background jobs that carry a stream id.
 */
export const lockedAfterCreation = (thread: { lockedAt?: number | null }, createdAt: number): boolean =>
    isThreadLocked(thread) && (thread.lockedAt ?? 0) > createdAt;

/**
 * A thread row as a list shows it: a locked row becomes its stub, anything else
 * passes through. The stub drops the content keys, so the typed row is only as
 * complete as the output validators allow (they all treat those keys as optional).
 */
export const threadRowForList = <T extends { _creationTime: number; _id: string; lockedAt?: number | null; status: string }>(thread: T): T =>
    isThreadLocked(thread) ? (toLockedThreadStub(thread) as unknown as T) : thread;

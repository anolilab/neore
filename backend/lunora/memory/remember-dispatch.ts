/**
 * A requested extraction's model call (`memory/extract.ts`, from `memory/remember.ts`) holds a dispatch claim on its chat
 * from the transaction that last checked the chat until the call is answered. Locking the chat waits while one is held
 * (`agent/thread-lock.ts`), so no prompt of a locked chat reaches the extractor, as for titles (`agent/thread-title.ts`).
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { claimFence, dropExpiredClaimsWithPrefix, hasClaimWithPrefix, releaseClaim } from "../lib/claim-once";

export const REMEMBER_DISPATCH_SCOPE = "memory-remember-dispatch";

/** Longer than the run's model calls (extraction, embedding, belief revision) may take; a claim never released frees the chat by itself. */
export const REMEMBER_DISPATCH_TTL_MS = 3 * 60 * 1000;

/** The time a dispatch call leaves unused before its claim lapses: the prompt is never out while the chat can be locked. */
export const REMEMBER_CALL_MARGIN_MS = 10 * 1000;

/**
 * How long the extractor's model call may run under a claim that lapses at `expiresAt`, as of `now`: what is left of the
 * claim, less the margin. `null` when nothing is left, so the call is not made. Timed from the claim, not from the call,
 * so the time between the two never stretches the call past the claim's life.
 */
export const dispatchCallDeadline = (expiresAt: number, now: number): number | null => {
    const remaining = expiresAt - now - REMEMBER_CALL_MARGIN_MS;

    return remaining > 0 ? remaining : null;
};

const dispatchKey = (threadId: string, promptMessageId: string): string => `${threadId}:${promptMessageId}`;

/** Whether a requested extraction's model call for this chat is being sent: locking the chat waits until none is. */
export const rememberDispatchInFlight = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<boolean> =>
    await hasClaimWithPrefix(ctx, REMEMBER_DISPATCH_SCOPE, `${threadId}:`);

/**
 * Takes the call's dispatch claim; the caller has checked the chat in the same transaction. Its `claimedAt` and when it
 * lapses, or `null` when one is held.
 */
export const takeRememberDispatch = async (
    ctx: Pick<MutationCtx, "db">,
    threadId: string,
    promptMessageId: string,
): Promise<{ claimedAt: number; expiresAt: number } | null> => {
    // Dispatches whose release never landed are cleared here, so the lock's check reads a short range.
    await dropExpiredClaimsWithPrefix(ctx, REMEMBER_DISPATCH_SCOPE, `${threadId}:`);

    const claimedAt = await claimFence(ctx, REMEMBER_DISPATCH_SCOPE, dispatchKey(threadId, promptMessageId), { ttlMs: REMEMBER_DISPATCH_TTL_MS });

    return claimedAt === null ? null : { claimedAt, expiresAt: claimedAt + REMEMBER_DISPATCH_TTL_MS };
};

/** The run's model calls are answered: its dispatch claim goes, and the chat may be locked. With no `claimedAt`, whichever this prompt holds. */
export const dropRememberDispatch = async (ctx: Pick<MutationCtx, "db">, threadId: string, promptMessageId: string, claimedAt?: number): Promise<void> => {
    await releaseClaim(ctx, REMEMBER_DISPATCH_SCOPE, dispatchKey(threadId, promptMessageId), claimedAt);
};

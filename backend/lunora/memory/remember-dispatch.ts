/**
 * A requested extraction's model call (`memory/extract.ts`, from `memory/remember.ts`) holds a dispatch claim on its chat
 * from the transaction that last checked the chat until the call is answered. Locking the chat waits while one is held
 * (`agent/thread-lock.ts`), so no prompt of a locked chat reaches the extractor, as for titles (`agent/thread-title.ts`).
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { claimFence, dropExpiredClaimsWithPrefix, hasClaimWithPrefix, releaseClaim } from "../lib/claim-once";

export const REMEMBER_DISPATCH_SCOPE = "memory-remember-dispatch";

/** Longer than the extractor's call may take; a claim whose release never lands frees the chat by itself. */
export const REMEMBER_DISPATCH_TTL_MS = 2 * 60 * 1000;

/**
 * The extractor's model call under a dispatch claim is aborted after this, well inside the claim's life: a slow gateway can
 * never send the prompt after the claim lapsed and the chat was locked.
 */
export const REMEMBER_CALL_TIMEOUT_MS = 90 * 1000;

const dispatchKey = (threadId: string, promptMessageId: string): string => `${threadId}:${promptMessageId}`;

/** Whether a requested extraction's model call for this chat is being sent: locking the chat waits until none is. */
export const rememberDispatchInFlight = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<boolean> =>
    await hasClaimWithPrefix(ctx, REMEMBER_DISPATCH_SCOPE, `${threadId}:`);

/** Takes the call's dispatch claim; the caller has checked the chat in the same transaction. Its `claimedAt`, or `null` when one is held. */
export const takeRememberDispatch = async (ctx: Pick<MutationCtx, "db">, threadId: string, promptMessageId: string): Promise<number | null> => {
    // Dispatches whose release never landed are cleared here, so the lock's check reads a short range.
    await dropExpiredClaimsWithPrefix(ctx, REMEMBER_DISPATCH_SCOPE, `${threadId}:`);

    return await claimFence(ctx, REMEMBER_DISPATCH_SCOPE, dispatchKey(threadId, promptMessageId), { ttlMs: REMEMBER_DISPATCH_TTL_MS });
};

/** The call was answered: its dispatch claim goes, and the chat may be locked. */
export const dropRememberDispatch = async (ctx: Pick<MutationCtx, "db">, threadId: string, promptMessageId: string, claimedAt: number): Promise<void> => {
    await releaseClaim(ctx, REMEMBER_DISPATCH_SCOPE, dispatchKey(threadId, promptMessageId), claimedAt);
};

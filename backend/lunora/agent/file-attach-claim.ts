/**
 * An in-flight file attach, on the CALLER's shard.
 *
 * A send or an edit that attaches files takes this claim, on the caller's own shard, in the same transaction that checks the
 * files are not gated (`beginFileAttach`, `agent/files.ts`). It is held until the attach's message is saved on the thread owner's
 * shard, then released. Locking one of the caller's chats (`enableThreadLock`) refuses while any claim of the caller is held, so
 * the lock cannot commit between the gate check and the owner-shard read that attaches the file. Same shape as the title dispatch
 * claim (`agent/thread-title.ts`).
 *
 * The claim lapses after {@link FILE_ATTACH_TTL_MS} if its release never lands, so a crashed attach cannot block locking for long.
 * An attach that runs past that window is no longer covered: the TTL is the bound, and it is set well above a normal attach.
 */
import type { QueryCtx } from "../_generated/server";
import { hasClaimWithPrefix } from "../lib/claim-once";

/** The claim scope (`lib/claim-once.ts`). Keys are `<userId>:<requestId>`. */
export const FILE_ATTACH_SCOPE = "file-attach";

/** A normal attach takes well under this; a crashed one stops blocking locks after it. */
export const FILE_ATTACH_TTL_MS = 3 * 60 * 1000;

/**
 * Time kept back from the claim's end. A save may start only inside `TTL - margin`, so it lands before the claim lapses even with
 * its own round trip and the clock skew between shards.
 */
export const FILE_ATTACH_SAVE_MARGIN_MS = 60 * 1000;

/**
 * Whether an attach that holds the claim taken at `claimedAt` may still save its message. Once it may not, a lock can commit
 * (the claim no longer holds it), so the save must not happen: the caller refuses the attach instead.
 */
export const attachWindowOpen = (claimedAt: number, now: number = Date.now()): boolean => now < claimedAt + FILE_ATTACH_TTL_MS - FILE_ATTACH_SAVE_MARGIN_MS;

/** Whether the caller holds an attach in flight: locking their chats waits until none is. */
export const fileAttachInFlight = async (context: Pick<QueryCtx, "db">, userId: string): Promise<boolean> =>
    await hasClaimWithPrefix(context, FILE_ATTACH_SCOPE, `${userId}:`);

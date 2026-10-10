/**
 * Which backend shard a call about a SHARED object goes to.
 *
 * Every row lives on the shard of the user who owns the object it belongs to
 * (docs/plans/per-user-sharding.md). The backend sends a call that names no
 * shard to the caller's own, which is right for everything the caller owns. A
 * thread or page someone else shared lives on THEIR shard, so calls about it
 * must name it — and the call's arguments are what say which object it is about.
 *
 * The registry is filled when the app learns an owner: accepting an invite, or
 * `resolveThreadShard` / `resolvePageShard` on opening a thread or page the
 * caller does not own. `crpc` and the live-query manager consult it for every
 * call, so no call site names a shard itself.
 */

const threadOwners = new Map<string, string>();
const pageOwners = new Map<string, string>();
const streamOwners = new Map<string, string>();
/** Objects whose shard is settled, the caller's own included (they have no owner entry). */
const resolvedThreads = new Set<string>();
const resolvedPages = new Set<string>();

/** Route every call about `threadId` to `ownerId`'s shard. */
export const registerThreadShard = (threadId: string, ownerId: string): void => {
    threadOwners.set(threadId, ownerId);
};

/** Route every call about `pageId` to `ownerId`'s shard. */
export const registerPageShard = (pageId: string, ownerId: string): void => {
    pageOwners.set(pageId, ownerId);
};

/**
 * A stream of `threadId` lives where the thread does: calls naming only the
 * `streamId` (`getStreamBody`) follow the thread's owner, if it has one.
 */
export const registerStreamOfThread = (streamId: string, threadId: string): void => {
    const owner = threadOwners.get(threadId);

    if (owner !== undefined) {
        streamOwners.set(streamId, owner);
    }
};

/** Record how `threadId` routes: `ownerId` for a thread shared with the caller, `null` for their own. */
export const noteThreadShard = (threadId: string, ownerId: string | null): void => {
    resolvedThreads.add(threadId);

    if (ownerId) {
        registerThreadShard(threadId, ownerId);
    }
};

/** Record how `pageId` routes: `ownerId` for a page shared with the caller, `null` for their own. */
export const notePageShard = (pageId: string, ownerId: string | null): void => {
    resolvedPages.add(pageId);

    if (ownerId) {
        registerPageShard(pageId, ownerId);
    }
};

/** Whether calls about `threadId` already know their shard. */
export const isThreadShardKnown = (threadId: string): boolean => resolvedThreads.has(threadId) || threadOwners.has(threadId);

/** Whether calls about `pageId` already know their shard. */
export const isPageShardKnown = (pageId: string): boolean => resolvedPages.has(pageId) || pageOwners.has(pageId);

/** Forget every registered owner (sign-out: the next user's grants are their own). */
export const resetShardRegistry = (): void => {
    threadOwners.clear();
    pageOwners.clear();
    streamOwners.clear();
    resolvedThreads.clear();
    resolvedPages.clear();
};

/**
 * The shard a call with `args` must name, or `undefined` for the caller's own.
 * Keyed on `threadId` (or the vault's `chatId`) / `pageId` / `streamId` — the
 * argument names every thread-, page- and stream-scoped procedure uses.
 */
export const shardKeyForArgs = (args: unknown): string | undefined => {
    if (args === null || typeof args !== "object") {
        return undefined;
    }

    // `chatId` is the vault's name for a thread id.
    const { chatId, pageId, streamId, threadId: namedThreadId } = args as { chatId?: unknown; pageId?: unknown; streamId?: unknown; threadId?: unknown };
    const threadId = namedThreadId ?? chatId;

    if (typeof streamId === "string") {
        const owner = streamOwners.get(streamId);

        if (owner !== undefined) {
            return owner;
        }
    }

    if (typeof threadId === "string") {
        const owner = threadOwners.get(threadId);

        if (owner !== undefined) {
            return owner;
        }
    }

    return typeof pageId === "string" ? pageOwners.get(pageId) : undefined;
};

/** `{ shardKey }` for a call with `args`, or `{}` — spread into a client call's options. */
export const shardOptionsFor = (args: unknown): { shardKey?: string } => {
    const shardKey = shardKeyForArgs(args);

    return shardKey === undefined ? {} : { shardKey };
};

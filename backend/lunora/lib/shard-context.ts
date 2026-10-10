/**
 * Which shard the running code is serving.
 *
 * `ctx.db` never routes by a table's `.shardBy()` field — a row lives in
 * whichever Durable Object executes the write (docs/plans/per-user-sharding.md).
 * So work a shard hands off (a `ctx.scheduler` job, a queue job) must name the
 * shard it came from, or it lands on `__root__`, where none of the user's rows
 * are. Nothing in the handler ctx says which shard that is, so `src/server.ts`
 * runs every `ShardDO` entry point inside {@link runInShard}, and the scheduler
 * namespace wrapper (`shard-scheduler.ts`) and `enqueueJob` default to
 * {@link currentUserShard}.
 *
 * Outside a shard — an HTTP action, the Worker's `queue()`/`scheduled()` — the
 * store is empty and callers must name the shard themselves.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The runtime's default shard when a request names none. */
export const ROOT_SHARD_KEY = "__root__";

const shardStorage = new AsyncLocalStorage<string>();

/** Run `callback` as code serving `shardKey`. An `undefined` key runs it with no shard context. */
export const runInShard = <T>(shardKey: string | undefined, callback: () => T): T =>
    shardKey === undefined ? callback() : shardStorage.run(shardKey, callback);

/** The shard the running code serves, or `undefined` outside a `ShardDO`. */
export const currentShard = (): string | undefined => shardStorage.getStore();

/** The current shard when it is a USER shard; `undefined` on `__root__` or outside a shard. */
export const currentUserShard = (): string | undefined => {
    const shardKey = currentShard();

    return shardKey === undefined || shardKey === ROOT_SHARD_KEY ? undefined : shardKey;
};

/**
 * The `shardKey` option for work owned by `ownerId`: routes it to the owner's
 * shard, or (for no owner) leaves it on `__root__`. Spread into a
 * `runAfter`/`runAt`/`enqueueJob` options bag.
 */
export const shardOf = (ownerId: string | null | undefined): { shardKey?: string } => (ownerId ? { shardKey: ownerId } : {});

/**
 * Whether the running code is on `userId`'s OWN shard — `true` outside any
 * shard context too (unit tests, the root cron), where nothing says otherwise.
 *
 * A collaborator's turn in a thread shared with them runs on the thread
 * OWNER's shard. Their memories live on their own, so memory retrieval and
 * extraction for that turn go to THEIR shard (`chat/lib/agent-run.ts`) instead
 * of reading from, or writing into, the owner's.
 */
export const servesUser = (userId: string): boolean => {
    const shardKey = currentUserShard();

    return shardKey === undefined || shardKey === userId;
};

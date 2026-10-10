/**
 * The shard a thread's work runs on: its OWNER's (docs/plans/per-user-sharding.md).
 *
 * For the owner that is their own shard; for a collaborator it is the owner who
 * granted them the thread, read from their `.global()` grant. No grant (or an
 * expired one) and no thread both answer the caller's own shard — where the
 * thread either is, or is not found, exactly as before.
 *
 * The grant is read ON THE CALLER'S OWN shard (a `.global()` table reads the
 * same from any), never on `__root__`: `/chat/chunks` asks this on every poll of
 * every stream, and routing all of them through the one root DO serialized
 * every user's streaming behind each other. Answers are cached per isolate for
 * a short while for the same reason.
 */
import { internal } from "../_generated/internal";

interface QueryRunner {
    runQuery: (reference: typeof internal.agent.sharing.getGrantOwner, args: { threadId: string; userId: string }) => Promise<string | null>;
}

interface ShardAwareContext extends QueryRunner {
    forShard?: (shardKey: string) => QueryRunner;
}

/** How long an answer is reused; a revoked grant is re-checked by the procedure itself. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 5000;
const cache = new Map<string, { expiresAt: number; shardKey: string }>();

export const threadShardFor = async (context: ShardAwareContext, userId: string, threadId: string | null | undefined): Promise<string> => {
    if (!threadId || threadId === "default") {
        return userId;
    }

    const key = `${userId}\n${threadId}`;
    const hit = cache.get(key);

    if (hit !== undefined && hit.expiresAt > Date.now()) {
        return hit.shardKey;
    }

    const runner = context.forShard?.(userId) ?? context;
    const shardKey = (await runner.runQuery(internal.agent.sharing.getGrantOwner, { threadId, userId })) ?? userId;

    if (cache.size >= CACHE_MAX) {
        cache.clear();
    }

    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, shardKey });

    return shardKey;
};

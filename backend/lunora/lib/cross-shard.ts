/**
 * Call a function on ANOTHER user's shard, from server code.
 *
 * `ctx.run*` stays on the shard it was called on, and a row lives only on its
 * owner's shard (docs/plans/per-user-sharding.md). The few server paths that
 * must read across users — an anonymous public share page, a gallery fork —
 * go through here: a system-privileged `createShardClient` call into the
 * owner's shard. Only from an ACTION or an HTTP action: it is an outbound
 * Durable Object request, which a query or mutation must not make.
 *
 * Authorization is the caller's job, exactly as for `createShardClient`: the
 * target is an internal function that re-checks what it serves (a public
 * token, an owner id).
 */
import { env } from "cloudflare:workers";
import type { ShardNamespaceLike } from "lunorash/runtime";
import { createShardClient } from "lunorash/runtime";

import { routedShardNamespace } from "./shard-namespace";

type ShardClient = ReturnType<typeof createShardClient>;

const shardNamespace = (): ShardNamespaceLike => {
    const namespace = (env as Record<string, unknown>)["SHARD"] as ShardNamespaceLike | undefined;

    if (!namespace) {
        throw new Error("The SHARD Durable Object binding is missing — check backend/wrangler.jsonc (dev) or alchemy.run.ts (deploy).");
    }

    return routedShardNamespace(namespace, env as { ENVIRONMENT?: string; SHARD_ROUTING?: string });
};

/** `reference(args)` on `shardKey`, as the system. */
export const callOnShard: ShardClient["call"] = async (reference, args, options) => await createShardClient(shardNamespace()).call(reference, args, options);

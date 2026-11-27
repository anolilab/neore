import { LunoraError } from "lunorash/server";

import type { QueryCtx } from "../_generated/server";
import { isErasing } from "../lib/account-moves";
import { env } from "cloudflare:workers";

import { currentShard, ROOT_SHARD_KEY, servesUser } from "../lib/shard-context";
import { isShardRoutingEnabled } from "../lib/shard-namespace";

/**
 * Refuses plugin work that would read or write an install's children away from the owner's shard. Skills, triggers and group
 * chats live there, so on `__root__` or another person's shard every child reads as missing, and the step would detach, recreate
 * or delete the wrong rows. Unlike `servesUser`, `__root__` is refused, except where development's `SHARD_ROUTING=off` runs every
 * user on it and it holds all their children. No shard context at all (a unit test) is allowed.
 */
export const requireOwnerShard = (userId: string, step: string): void => {
    // The Worker's own `env` carries `SHARD_ROUTING`; `process.env` does not, in a Worker. Read as `cross-shard.ts` does.
    const routing = env as { ENVIRONMENT?: string; SHARD_ROUTING?: string };
    const onOwnShard = (currentShard() !== ROOT_SHARD_KEY || !isShardRoutingEnabled(routing)) && servesUser(userId);

    if (!onOwnShard) {
        throw new LunoraError("CONFLICT", `The ${step} must run on the owner's shard`);
    }
};

/**
 * Refuses a step that creates plugin rows while the account is being erased. An install action already running when the erasure
 * began would otherwise write rows after the sweep has passed them, and nothing would remove them.
 */
export const refuseWhileErasing = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<void> => {
    if (await isErasing(ctx, userId)) {
        throw new LunoraError("CONFLICT", "This account is being deleted, so plugins can no longer be changed");
    }
};

import { LunoraError } from "lunorash/server";

import { currentShard } from "../lib/shard-context";

/**
 * Refuses plugin work that would read or write an install's children away from the owner's shard. Skills, triggers and group
 * chats live there, so on `__root__` or another person's shard every child reads as missing, and the step would detach, recreate
 * or delete the wrong rows. Unlike `servesUser`, `__root__` is refused. No shard context at all (a unit test) is allowed.
 */
export const requireOwnerShard = (userId: string, step: string): void => {
    const shard = currentShard();

    if (shard !== undefined && shard !== userId) {
        throw new LunoraError("CONFLICT", `The ${step} must run on the owner's shard`);
    }
};

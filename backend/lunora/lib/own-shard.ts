/**
 * Whether the running code is on `userId`'s own shard, for rows that must live
 * there and nowhere else.
 *
 * A call that names no shard lands on the caller's own (`src/shard-routing.ts`),
 * but a collaborator may name the shard of a thread or page shared with them,
 * and any signed-in caller may name `__root__`. A row a user saves there would
 * escape that user's GDPR export, erasure and account merge, which read only
 * the user's own shard. No shard context at all (unit tests) counts as own, and
 * so does `__root__` while development runs every user on it
 * (`SHARD_ROUTING=off`), where export and erasure read too.
 */
import { env } from "cloudflare:workers";

import { currentShard, ROOT_SHARD_KEY, servesUser } from "./shard-context";
import { isShardRoutingEnabled } from "./shard-namespace";

export const onOwnShard = (userId: string): boolean =>
    (currentShard() !== ROOT_SHARD_KEY || !isShardRoutingEnabled(env as { ENVIRONMENT?: string; SHARD_ROUTING?: string })) && servesUser(userId);

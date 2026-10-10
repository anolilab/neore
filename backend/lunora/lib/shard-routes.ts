/**
 * `shardRoutes`: from a key known before the owner is, to the owner's shard
 * (docs/plans/per-user-sharding.md).
 *
 * A public share token, a messenger connection id or a trigger id arrives on a
 * request that names no user — an anonymous share page, a platform webhook —
 * while the row it names lives on its owner's shard. The row's writer records
 * the route here (`.global()`, so any shard and the Worker can read it); the
 * reader resolves the owner first and then calls into that shard.
 */
import { v } from "lunorash/server";

import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";

/**
 * `thread-public` routes a share TOKEN (the anonymous share page);
 * `thread-share` routes the id of a PUBLIC thread, so `/chat/<id>` opened by a
 * signed-in stranger can still find its share page.
 */
export type ShardRouteKind = "messenger" | "page-public" | "thread-public" | "thread-share" | "trigger";

/** The `shardRoutes.key` for `value` of `kind`. */
export const shardRouteKey = (kind: ShardRouteKind, value: string): string => `${kind}:${value}`;

/** The owner `key` routes to, or `null`. */
export const shardRouteOwner = async (context: Pick<QueryCtx, "db">, kind: ShardRouteKind, value: string): Promise<string | null> => {
    const route = await context.db.shardRoutes.findFirst({ where: { key: shardRouteKey(kind, value) } });

    return route?.ownerId ?? null;
};

/** Route `value` of `kind` to `ownerId`'s shard. Idempotent. */
export const setShardRoute = async (context: Pick<MutationCtx, "db">, kind: ShardRouteKind, value: string, ownerId: string): Promise<void> => {
    const key = shardRouteKey(kind, value);
    const existing = await context.db.shardRoutes.findFirst({ where: { key } });

    if (existing) {
        if (existing.ownerId !== ownerId) {
            await context.db.patch(existing._id, { ownerId });
        }

        return;
    }

    await context.db.insert("shardRoutes", { createdAt: Date.now(), key, ownerId });
};

/** Forget the route for `value` of `kind`, if any. */
export const deleteShardRoute = async (context: Pick<MutationCtx, "db">, kind: ShardRouteKind, value: string): Promise<void> => {
    const existing = await context.db.shardRoutes.findFirst({ where: { key: shardRouteKey(kind, value) } });

    if (existing) {
        await context.db.delete(existing._id);
    }
};

/** Every route to `ownerId`'s shard, and its housekeeping census row — for account deletion. */
export const deleteShardRoutesOf = async (context: Pick<MutationCtx, "db">, ownerId: string): Promise<void> => {
    const [{ page: routes }, { page: census }] = await Promise.all([
        context.db.shardRoutes.findMany({ where: { ownerId } }),
        context.db.shardActivity.findMany({ where: { shardKey: ownerId } }),
    ]);

    for (const row of [...routes, ...census]) {
        await context.db.delete(row._id);
    }
};

/** The owner `value` of `kind` routes to — for HTTP actions, which resolve it before choosing a shard. */
export const getRouteOwner = internalQuery
    .input({
        kind: v.union(v.literal("messenger"), v.literal("page-public"), v.literal("thread-public"), v.literal("thread-share"), v.literal("trigger")),
        value: v.string(),
    })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => await shardRouteOwner(ctx, args.kind, args.value));

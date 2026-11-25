/**
 * `shardRoutes`: from a key known before the owner is, to the owner's shard.
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
 * signed-in stranger can still find its share page. `device` routes a paired
 * device's id to its owner, for the host ingest (`acp/http.ts`). `watch` routes a
 * watched repository's id to its owner, for the repository webhook
 * (`source-control/webhook.ts`). `guest-link` routes the SHA-256 of a guest link token to the
 * thread owner, for the guest's message and view (`chat/guest-links.ts`). `merged-guest` routes a converting guest's id
 * to the account it merges into, written before the merge reads any of the guest's grants (`lib/account-merge.ts`).
 */
export type ShardRouteKind = "device" | "guest-link" | "merged-guest" | "messenger" | "page-public" | "thread-public" | "thread-share" | "trigger" | "watch";

/** The `shardRoutes.key` for `value` of `kind`. */
export const shardRouteKey = (kind: ShardRouteKind, value: string): string => `${kind}:${value}`;

/** The owner `key` routes to, or `null`. */
export const shardRouteOwner = async (context: Pick<QueryCtx, "db">, kind: ShardRouteKind, value: string): Promise<string | null> => {
    const route = await context.db.shardRoutes.findFirst({ where: { key: shardRouteKey(kind, value) } });

    return route?.ownerId ?? null;
};

/**
 * The account guest `userId` is merging into, once its merge has started: read from the primary, as a write under the
 * guest reads it right after itself (`agent/grant-revision.ts`), and a replica could still miss the mark.
 */
export const mergedGuestTarget = async (context: Pick<QueryCtx, "db">, userId: string): Promise<string | null> => {
    const route = await context.db.shardRoutes.findFirst({ consistency: "primary", where: { key: shardRouteKey("merged-guest", userId) } });

    return route?.ownerId ?? null;
};

/**
 * Route `value` of `kind` to `ownerId`'s shard. Idempotent. `primary` for a route written again right after itself (a
 * retried `merged-guest` mark): a replica that has not seen the first write yet would read as "no route" and add a second.
 */
export const setShardRoute = async (
    context: Pick<MutationCtx, "db">,
    kind: ShardRouteKind,
    value: string,
    ownerId: string,
    { primary = false }: { primary?: boolean } = {},
): Promise<void> => {
    const key = shardRouteKey(kind, value);
    const existing = await context.db.shardRoutes.findFirst(primary ? { consistency: "primary", where: { key } } : { where: { key } });

    if (existing) {
        if (existing.ownerId !== ownerId) {
            await context.db.patch("shardRoutes", existing._id, { ownerId });
        }

        return;
    }

    await context.db.insert("shardRoutes", { createdAt: Date.now(), key, ownerId });
};

/**
 * Forget every route for `value` of `kind`. Read from the primary: a replica that has not seen the route yet would read
 * as "no route" and leave it behind (a `merged-guest` mark set moments before, say). Every row, not the first: `key` has
 * no unique index, so a write that once read a stale replica may have left a second.
 */
export const deleteShardRoute = async (context: Pick<MutationCtx, "db">, kind: ShardRouteKind, value: string): Promise<void> => {
    const { page } = await context.db.shardRoutes.findMany({ consistency: "primary", where: { key: shardRouteKey(kind, value) } });

    for (const row of page) {
        await context.db.delete("shardRoutes", row._id);
    }
};

/**
 * Drops the routes a deleted thread's public share left behind: its token's
 * (`thread-public`) and its own id's (`thread-share`). A thread that was never
 * published costs no read. A route write never fails the delete, so a failure
 * is logged and the thread is gone regardless.
 */
export const deleteThreadShardRoutes = async (
    context: Pick<MutationCtx, "db">,
    thread: { isPublic?: boolean | null; publicAccessToken?: string | null },
    threadId: string,
): Promise<void> => {
    if (!thread.publicAccessToken && thread.isPublic !== true) {
        return;
    }

    try {
        if (thread.publicAccessToken) {
            await deleteShardRoute(context, "thread-public", thread.publicAccessToken);
        }

        await deleteShardRoute(context, "thread-share", threadId);
    } catch (error) {
        console.error("[shard-routes] Failed to drop the share routes of a deleted thread:", error);
    }
};

/** Every route to `ownerId`'s shard, and its housekeeping census row — for account deletion. */
export const deleteShardRoutesOf = async (context: Pick<MutationCtx, "db">, ownerId: string): Promise<void> => {
    const [{ page: routes }, { page: census }] = await Promise.all([
        context.db.shardRoutes.findMany({ where: { ownerId } }),
        context.db.shardActivity.findMany({ where: { shardKey: ownerId } }),
    ]);

    for (const row of routes) {
        await context.db.delete("shardRoutes", row._id);
    }

    for (const row of census) {
        await context.db.delete("shardActivity", row._id);
    }
};

/** The owner `value` of `kind` routes to — for HTTP actions, which resolve it before choosing a shard. */
export const getRouteOwner = internalQuery
    .input({
        kind: v.union(
            v.literal("device"),
            v.literal("guest-link"),
            v.literal("messenger"),
            v.literal("page-public"),
            v.literal("thread-public"),
            v.literal("thread-share"),
            v.literal("trigger"),
            v.literal("watch"),
        ),
        value: v.string(),
    })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => await shardRouteOwner(ctx, args.kind, args.value));

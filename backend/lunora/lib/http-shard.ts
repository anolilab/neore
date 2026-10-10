/**
 * An HTTP action, bound to one user's shard.
 *
 * An HTTP action runs in the Worker, not in a shard, so `ctx.runQuery` and
 * friends reach the DEFAULT shard (`__root__`) — which holds none of a user's
 * rows now that every request routes to its owner's shard
 * (docs/plans/per-user-sharding.md). {@link inShard} hands the handler a ctx
 * whose runners are `ctx.forShard(shardKey)`'s, and runs it inside that shard's
 * ALS context (`shard-context.ts`), so `ctx.scheduler` jobs and `enqueueJob`
 * default to the same shard without each call site naming it.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import { runInShard } from "./shard-context";
import type { ShardRouteKind } from "./shard-routes";
import { threadShardFor } from "./thread-shard";

/** `context` with its `run*` trio aimed at `shardKey`. Everything else is unchanged. */
export const shardContext = (context: HttpActionCtx, shardKey: string): HttpActionCtx => {
    return { ...context, ...context.forShard(shardKey) };
};

/** When each shard's activity was last recorded from this isolate. */
const activityRecordedAt = new Map<string, number>();
const ACTIVITY_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Enter `shardKey` in the housekeeping census (`shard-housekeeping.ts`), at most
 * once per throttle window per isolate. Best effort: the request it rides on
 * must not fail because of it.
 */
const recordActivity = async (context: HttpActionCtx, shardKey: string): Promise<void> => {
    const now = Date.now();

    if (now - (activityRecordedAt.get(shardKey) ?? 0) < ACTIVITY_THROTTLE_MS) {
        return;
    }

    activityRecordedAt.set(shardKey, now);
    await context
        .forShard(shardKey)
        .runMutation(internal.lib.shard_housekeeping.recordShardActivity, { shardKey })
        .catch(() => undefined);
};

/** Run `handler` against `shardKey` — runners, scheduler and queue default all aimed at it. */
export const inShard = async <T>(context: HttpActionCtx, shardKey: string, handler: (shardCtx: HttpActionCtx) => Promise<T>): Promise<T> => {
    // Off the critical path: best effort, and it must not delay the request.
    void recordActivity(context, shardKey);

    return await runInShard(shardKey, async () => await handler(shardContext(context, shardKey)));
};

/**
 * Wrap a session-authenticated HTTP action so it runs on the CALLER's shard.
 * An anonymous request runs unchanged (on `__root__`); the handler's own auth
 * check refuses it as before.
 */
export const onCallerShard =
    (handler: (context: HttpActionCtx, request: Request) => Promise<Response>) =>
    async (context: HttpActionCtx, request: Request): Promise<Response> => {
        const { userId } = context.auth;

        return userId ? await inShard(context, userId, async (shardCtx) => await handler(shardCtx, request)) : await handler(context, request);
    };

/** The `threadId` a JSON request body names, read from a clone so the handler still reads the body. */
const bodyThreadId = async (request: Request): Promise<string | undefined> => {
    try {
        const body = (await request.clone().json()) as { threadId?: unknown } | null;

        return typeof body?.threadId === "string" && body.threadId.length > 0 ? body.threadId : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Like {@link onCallerShard}, but on the OWNER's shard of the thread the body
 * names (`threadId`) — a thread shared with the caller lives there, not on the
 * caller's (`thread-shard.ts`). No `threadId`, or no grant on it: the caller's
 * shard, where the handler finds the caller's own rows or nothing.
 */
export const onThreadShard =
    (handler: (context: HttpActionCtx, request: Request) => Promise<Response>) =>
    async (context: HttpActionCtx, request: Request): Promise<Response> => {
        const { userId } = context.auth;

        if (!userId) {
            return await handler(context, request);
        }

        const threadId = await bodyThreadId(request);
        const shardKey = threadId ? await threadShardFor(context, userId, threadId) : userId;

        return await inShard(context, shardKey, async (shardCtx) => await handler(shardCtx, request));
    };

/**
 * Run `handler` on the shard `value` of `kind` routes to (`shardRoutes`) — a
 * webhook knows a connection or trigger id, not whose it is. An unknown key
 * runs on the default shard, where the handler finds nothing and answers as it
 * would for any unknown id.
 */
export const onRoutedShard = async <T>(
    context: HttpActionCtx,
    kind: ShardRouteKind,
    value: string,
    handler: (shardCtx: HttpActionCtx) => Promise<T>,
): Promise<T> => {
    const ownerId = await context.runQuery(internal.lib.shard_routes.getRouteOwner, { kind, value });

    return ownerId ? await inShard(context, ownerId, handler) : await handler(context);
};

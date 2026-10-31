/**
 * An HTTP action, bound to one user's shard.
 *
 * An HTTP action runs in the Worker, not in a shard, so `ctx.runQuery` and
 * friends reach the DEFAULT shard (`__root__`) — which holds none of a user's
 * rows now that every request routes to its owner's shard.
 * {@link inShard} hands the handler a ctx
 * whose runners are `ctx.forShard(shardKey)`'s, and runs it inside that shard's
 * ALS context (`shard-context.ts`), so `ctx.scheduler` jobs and `enqueueJob`
 * default to the same shard without each call site naming it.
 *
 * Two ways to reach a shard, and which one a route may use is a security rule:
 *
 * - {@link inShard} / {@link shardContext} use `ctx.forShard(key)`. The runtime
 *   authorizes that against the HTTP REQUEST's identity, so it fits a route that
 *   authenticates a user (session, bearer, API key) and only ever refuses.
 * - {@link inSystemShard} / {@link systemShardContext} cross as the SYSTEM
 *   (`cross-shard.ts`): no identity check at all, `internal.*` functions allowed.
 *   They exist for server-to-server routes that carry no user identity but
 *   authenticate THEMSELVES (gateway HMAC, device signature, webhook secret).
 *   Use them only AFTER the route has verified its own credentials, and take the
 *   shard key from the verified payload or from server data (`shardRoutes`),
 *   never from an unverified request. A system context is every user's shard.
 */
import type { HttpActionCtx, HttpRunners } from "lunorash/server";

import { internal } from "../_generated/internal";
import { callOnShard } from "./cross-shard";
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
const recordActivity = async (runners: HttpRunners, shardKey: string): Promise<void> => {
    const now = Date.now();

    if (now - (activityRecordedAt.get(shardKey) ?? 0) < ACTIVITY_THROTTLE_MS) {
        return;
    }

    activityRecordedAt.set(shardKey, now);
    await runners.runMutation(internal.lib.shard_housekeeping.recordShardActivity, { shardKey }).catch(() => undefined);
};

/** Run `handler` against `shardKey` — runners, scheduler and queue default all aimed at it. */
export const inShard = async <T>(context: HttpActionCtx, shardKey: string, handler: (shardCtx: HttpActionCtx) => Promise<T>): Promise<T> => {
    // Off the critical path: best effort, and it must not delay the request.
    void recordActivity(context.forShard(shardKey), shardKey);

    return await runInShard(shardKey, async () => await handler(shardContext(context, shardKey)));
};

/**
 * The `run*` trio aimed at `shardKey` AS THE SYSTEM. Whoever holds this can run
 * any function on that user's shard: see the header before reaching for it.
 */
export const systemRunners = (shardKey: string): HttpRunners => {
    const run = async (reference: unknown, args?: Record<string, unknown>): Promise<unknown> =>
        await callOnShard(reference as never, (args ?? {}) as never, { shardKey });

    return { runAction: run, runMutation: run, runQuery: run } as unknown as HttpRunners;
};

/**
 * Like {@link shardContext}, but crossing as the system. `forShard` is left as
 * the runtime's (identity-checked), so a handler that calls `ctx.forShard(x)`
 * cannot reach an arbitrary shard as the system; helpers that must cross take
 * {@link systemRunners} explicitly. Only after the route verified its own credentials.
 */
export const systemShardContext = (context: HttpActionCtx, shardKey: string): HttpActionCtx => {
    return { ...context, ...systemRunners(shardKey) };
};

/**
 * Run `handler` against `shardKey` as the system, with runners, scheduler and queue default all aimed at it.
 * Only after the route verified its own credentials.
 */
export const inSystemShard = async <T>(context: HttpActionCtx, shardKey: string, handler: (shardCtx: HttpActionCtx) => Promise<T>): Promise<T> => {
    void recordActivity(systemRunners(shardKey), shardKey);

    return await runInShard(shardKey, async () => await handler(systemShardContext(context, shardKey)));
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
 *
 * The shard key comes from server data, never from the request, and the
 * crossing is as the system (a webhook has no user identity). The request is
 * NOT verified yet when this runs: every handler checks its platform signature
 * itself, before it acts on anything the request said (see `messenger/webhooks.ts`,
 * `triggers/http.ts`). A new caller's handler must do the same.
 */
export const onRoutedShard = async <T>(
    context: HttpActionCtx,
    kind: ShardRouteKind,
    value: string,
    handler: (shardCtx: HttpActionCtx) => Promise<T>,
): Promise<T> => {
    const ownerId = await context.runQuery(internal.lib.shard_routes.getRouteOwner, { kind, value });

    return ownerId ? await inSystemShard(context, ownerId, handler) : await handler(context);
};

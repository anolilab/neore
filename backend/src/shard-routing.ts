/**
 * Worker-side shard routing: which Durable Object a client request lands on,
 * and who may land there (docs/plans/per-user-sharding.md).
 *
 * - {@link withCallerShard}: an RPC, RPC batch entry or live-query socket that
 *   names no shard is sent to the CALLER's own shard. Done here rather than in
 *   each client so the web app, the extension, SSR and the CLI cannot forget
 *   it; a client only names a shard to reach someone else's (a shared thread).
 * - {@link createShardAuthorizer}: `authorizeShard`. A caller may reach
 *   `__root__`, their own shard, or the shard of an owner who granted them a
 *   thread or a page. Each procedure's own access check still runs.
 */
import type { D1DatabaseLike } from "@lunora/d1";

import { ROOT_SHARD_KEY } from "../lunora/lib/shard-context.js";

const RPC_PATH = "/_lunora/rpc";
const RPC_BATCH_PATH = "/_lunora/rpc-batch";
const WS_PATH = "/_lunora/ws";

const namesShard = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/** Whether `request` is one {@link withCallerShard} may route. */
export const isShardRoutedRequest = (request: Request): boolean => {
    const { pathname } = new URL(request.url);

    if (request.method === "POST") {
        return pathname === RPC_PATH || pathname === RPC_BATCH_PATH;
    }

    return request.method === "GET" && pathname === WS_PATH;
};

/**
 * `request`, sent to `shardKey` wherever it names no shard itself. Returns the
 * SAME object when nothing changes (no shard to add, not a routed path, a body
 * that is not a JSON envelope) — the runtime then parses and rejects it as it
 * would have anyway.
 */
export const withCallerShard = async (request: Request, shardKey: string | undefined): Promise<Request> => {
    if (shardKey === undefined || !isShardRoutedRequest(request)) {
        return request;
    }

    const url = new URL(request.url);

    if (url.pathname === WS_PATH) {
        if (url.searchParams.has("shard")) {
            return request;
        }

        url.searchParams.set("shard", shardKey);

        return new Request(url, request);
    }

    let envelope: unknown;

    try {
        envelope = JSON.parse(await request.clone().text());
    } catch {
        return request;
    }

    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
        return request;
    }

    const record = envelope as { calls?: unknown; fanOut?: unknown; shardKey?: unknown };
    let routed: Record<string, unknown>;

    if (url.pathname === RPC_BATCH_PATH) {
        if (!Array.isArray(record.calls)) {
            return request;
        }

        routed = {
            ...record,
            calls: record.calls.map((call: unknown) =>
                call !== null && typeof call === "object" && !namesShard((call as { shardKey?: unknown }).shardKey) ? { ...call, shardKey } : call,
            ),
        };
    } else {
        // A fan-out addresses every shard; pinning it to one would change what it means.
        if (namesShard(record.shardKey) || record.fanOut !== undefined) {
            return request;
        }

        routed = { ...record, shardKey };
    }

    const headers = new Headers(request.headers);

    headers.delete("content-length");

    return new Request(request.url, { body: JSON.stringify(routed), headers, method: request.method, signal: request.signal });
};

/** Whether `callerId` holds a live grant from `ownerId` (a shared thread or page). */
export type GrantLookup = (callerId: string, ownerId: string) => Promise<boolean>;

type GrantDatabase = Pick<D1DatabaseLike, "prepare">;

/** How long a grant answer is reused. A revoked grant passes the SHARD gate this long; the procedure re-checks the grant row itself. */
export const GRANT_CACHE_TTL_MS = 30_000;
const GRANT_CACHE_MAX = 5000;

/**
 * The {@link GrantLookup} over the `.global()` grant tables, read raw from D1 (the
 * worker has no `ctx.db`). A table not created yet — `.global()` tables are
 * created lazily on first ORM access — is an error, which reads as "no grant".
 * Answers, negative ones included, are cached per isolate for
 * {@link GRANT_CACHE_TTL_MS}.
 */
export const createGrantLookup = (database: GrantDatabase, now: () => number = Date.now): GrantLookup => {
    const cache = new Map<string, { expiresAt: number; granted: boolean }>();

    const query = async (callerId: string, ownerId: string): Promise<boolean> => {
        const at = now();

        for (const statement of [
            `SELECT 1 AS "granted" FROM "threadAccess" WHERE "userId" = ? AND "ownerId" = ? AND ("expiresAt" IS NULL OR "expiresAt" > ${String(at)}) LIMIT 1`,
            `SELECT 1 AS "granted" FROM "pageAccess" WHERE "userId" = ? AND "ownerId" = ? LIMIT 1`,
        ]) {
            try {
                if ((await database.prepare(statement).bind(callerId, ownerId).first()) !== null) {
                    return true;
                }
            } catch {
                // Table not created yet: no grant in it.
            }
        }

        return false;
    };

    return async (callerId, ownerId) => {
        const key = `${callerId}\n${ownerId}`;
        const hit = cache.get(key);

        if (hit !== undefined && hit.expiresAt > now()) {
            return hit.granted;
        }

        const granted = await query(callerId, ownerId);

        if (cache.size >= GRANT_CACHE_MAX) {
            cache.clear();
        }

        cache.set(key, { expiresAt: now() + GRANT_CACHE_TTL_MS, granted });

        return granted;
    };
};

/**
 * `authorizeShard`. `shardKey` is either `__root__` or a user id (every sharded
 * table is `.shardBy("userId")`), so the rule is exact:
 *
 * - `__root__` is open. Anonymous callers legitimately reach it (the
 *   changelog on first paint), and a signed-in caller only lands there by
 *   naming it. It holds cron bookkeeping and HTTP-level rate limits, no user
 *   data — but this repo declares no RLS on it, so a procedure's own guard is
 *   still the only control there.
 * - A user shard is open to its owner, compared by EQUALITY: an earlier
 *   version allowed any key not starting with `user_`, and better-auth ids
 *   carry no prefix, so it allowed everyone.
 * - …and to a caller the owner granted a thread or page, so a collaborator can
 *   read and write the shared object where it lives.
 */
export const createShardAuthorizer =
    (lookupGrant: GrantLookup) =>
    async ({ identity, shardKey }: { identity: { userId?: string } | null; shardKey: string }): Promise<boolean> => {
        if (shardKey === ROOT_SHARD_KEY) {
            return true;
        }

        const callerId = identity?.userId;

        if (callerId === undefined) {
            return false;
        }

        return shardKey === callerId || (await lookupGrant(callerId, shardKey));
    };

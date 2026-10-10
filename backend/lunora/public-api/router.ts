/**
 * The `/api/v1` hono app, mounted by `http.ts`.
 *
 * Every route in `routes.ts` runs through `handle`, in this order:
 *
 *   1. identity   — the API key resolved by `server.ts` (`identity.ts`); 401 without one
 *   2. scopes     — every scope the route lists; 403 `insufficient_scope`
 *   3. key limit  — `publicApi/read` or `publicApi/write` for this key id; 429
 *   4. body       — size cap, JSON, zod; 400 / 413
 *   5. idempotency — POSTs with `Idempotency-Key`
 *   6. handler    — an existing procedure, as the key's owner
 *
 * and every failure is rendered by `errors.ts` in the one public error shape.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { HttpActionCtx, LunoraHttpEnv } from "lunorash/server";

import { internal } from "../_generated/internal";
import { PUBLIC_ORIGIN } from "../env";
import { inShard } from "../lib/http-shard";
import { httpLogger } from "../lib/logger";
import { errorResponse, fromProcedureError, PublicApiError } from "./errors";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";
import { IDEMPOTENCY_FAMILY, IDEMPOTENCY_HEADER, parseIdempotencyKey, withIdempotency } from "./idempotency";
import type { ApiKeyIdentity } from "./identity";
import { extractApiKey, readApiKeyIdentity } from "./identity";
import { buildOpenApiDocument, renderDocsHtml } from "./openapi";
import type { RouteDefinition, RouteResult } from "./routes";
import { ROUTES, toHonoPath } from "./routes";
import { formatScope, hasScope } from "./scopes";

/** Request bodies are prompts and small JSON; file bytes go to the upload route (`/api/v1/uploads`), not here. */
export const MAX_BODY_BYTES = 512 * 1024;

const requestIdOf = (c: Context<LunoraHttpEnv>): string => {
    // Set by `hono/request-id` in `http.ts`, which also echoes it as `X-Request-Id`.
    const id = (c as unknown as { get: (key: string) => unknown }).get("requestId");

    return typeof id === "string" ? id : crypto.randomUUID();
};

/** The scopes a route needs that this key lacks. */
export const missingScopes = (identity: ApiKeyIdentity, route: Pick<RouteDefinition, "scopes">): string[] =>
    route.scopes.filter(([resource, action]) => !hasScope(identity.apiKeyScopes, resource, action)).map(([resource, action]) => formatScope(resource, action));

const authenticate = async (ctx: HttpActionCtx, request: Request): Promise<ApiKeyIdentity> => {
    const identity = readApiKeyIdentity(await ctx.auth.getIdentity(), ctx.auth.userId);

    if (identity) {
        return identity;
    }

    if (extractApiKey(request.headers)) {
        throw new PublicApiError("invalid_api_key", "The API key is invalid, disabled or expired.");
    }

    throw new PublicApiError("unauthenticated", "Send an API key as `Authorization: Bearer <key>`.");
};

const applyKeyRateLimit = async (ctx: HttpActionCtx, identity: ApiKeyIdentity, isWrite: boolean): Promise<void> => {
    const result = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
        identifier: identity.apiKeyId,
        key: isWrite ? "publicApi/write:free" : "publicApi/read:free",
    });

    if (!result.ok) {
        throw new PublicApiError("rate_limited", "Too many requests for this API key.", { retryAfterSeconds: (result.retryAfter ?? 1000) / 1000 });
    }
};

const readBody = async (route: RouteDefinition, request: Request): Promise<{ parsed: unknown; raw: string }> => {
    const declared = Number(request.headers.get("Content-Length") ?? "0");

    if (declared > MAX_BODY_BYTES) {
        throw new PublicApiError("payload_too_large", `Request bodies are limited to ${String(MAX_BODY_BYTES)} bytes.`);
    }

    const raw = await request.text();

    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        throw new PublicApiError("payload_too_large", `Request bodies are limited to ${String(MAX_BODY_BYTES)} bytes.`);
    }

    if (!route.body) {
        return { parsed: undefined, raw };
    }

    let json: unknown;

    try {
        json = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
        throw new PublicApiError("invalid_request", "The request body is not valid JSON.");
    }

    const result = route.body.safeParse(json);

    if (!result.success) {
        throw new PublicApiError("invalid_request", "The request body failed validation.", {
            issues: result.error.issues.map((issue) => {
                return { message: issue.message, path: issue.path.join(".") };
            }),
        });
    }

    return { parsed: result.data, raw };
};

const idempotencyStore = (ctx: HttpActionCtx): IdempotencyStore => {
    return {
        get: async (key) => {
            const result = await ctx.runQuery(internal.lib.action_cache.get, { key, now: Date.now() });

            return result.kind === "hit" ? result.value : undefined;
        },
        put: async (key, value: IdempotencyRecord, ttlMs) => {
            await ctx.runMutation(internal.lib.action_cache.put, { key, name: IDEMPOTENCY_FAMILY, ttl: ttlMs, value });
        },
        remove: async (key) => {
            await ctx.runMutation(internal.lib.action_cache.remove, { key });
        },
    };
};

const toResponse = (route: RouteDefinition, result: RouteResult): Response =>
    result instanceof Response ? result : Response.json(result.data, { status: result.status ?? route.successStatus ?? 200 });

const handle = async (route: RouteDefinition, c: Context<LunoraHttpEnv>): Promise<Response> => {
    const requestId = requestIdOf(c);
    const request = c.req.raw;

    try {
        const identity = await authenticate(c.var.lunora, request);
        const missing = missingScopes(identity, route);

        if (missing.length > 0) {
            throw new PublicApiError("insufficient_scope", `This API key lacks the required scope: ${missing.join(", ")}.`, { required: missing });
        }

        // Everything the key does runs on its owner's shard, where their rows
        // live (docs/plans/per-user-sharding.md) — the per-key limit included.
        return await inShard(c.var.lunora, identity.userId, async (ctx) => await handleOnShard(route, c, ctx, identity, requestId));
    } catch (error) {
        return failure(route, error, requestId);
    }
};

/**
 * The gate `/api/v1/uploads` (`http.ts`, `lib/upload-route.ts`) runs on the
 * key owner's shard before the upload handler: an API key with
 * `knowledge:write` — the one v1 resource that takes files — on every request,
 * and the key's write limit on each create. `undefined` lets it through.
 */
export const publicApiUploadGate = async (ctx: HttpActionCtx, request: Request): Promise<Response | undefined> => {
    try {
        const identity = await authenticate(ctx, request);
        const missing = missingScopes(identity, { scopes: [["knowledge", "write"]] });

        if (missing.length > 0) {
            throw new PublicApiError("insufficient_scope", `This API key lacks the required scope: ${missing.join(", ")}.`, { required: missing });
        }

        if (request.method === "POST") {
            await applyKeyRateLimit(ctx, identity, true);
        }

        return undefined;
    } catch (error) {
        return errorResponse(fromProcedureError(error));
    }
};

const failure = (route: RouteDefinition, error: unknown, requestId: string): Response => {
    const apiError = fromProcedureError(error);

    if (apiError.code === "internal_error") {
        httpLogger.error(`[public-api] ${route.operationId} failed (${requestId}):`, error);
    }

    return errorResponse(apiError, requestId);
};

const handleOnShard = async (
    route: RouteDefinition,
    c: Context<LunoraHttpEnv>,
    ctx: HttpActionCtx,
    identity: ApiKeyIdentity,
    requestId: string,
): Promise<Response> => {
    const request = c.req.raw;

    try {
        await applyKeyRateLimit(ctx, identity, route.method !== "get");

        const url = new URL(request.url);
        const idempotencyKey = route.method === "post" ? parseIdempotencyKey(request.headers.get(IDEMPOTENCY_HEADER)) : undefined;
        const body = route.method === "get" ? { parsed: undefined, raw: "" } : await readBody(route, request);
        const run = async (): Promise<Response> =>
            toResponse(
                route,
                await route.handler({
                    body: body.parsed,
                    ctx,
                    identity,
                    params: c.req.param() as Record<string, string>,
                    query: Object.fromEntries(url.searchParams),
                    signal: request.signal,
                }),
            );

        const response = idempotencyKey
            ? await withIdempotency(
                  idempotencyStore(ctx),
                  { apiKeyId: identity.apiKeyId, body: body.raw, idempotencyKey, method: request.method, pathAndQuery: url.pathname + url.search },
                  run,
              )
            : await run();

        response.headers.set("X-Request-Id", requestId);

        return response;
    } catch (error) {
        return failure(route, error, requestId);
    }
};

export const createPublicApiRouter = (): Hono<LunoraHttpEnv> => {
    const router = new Hono<LunoraHttpEnv>();

    // Public: the contract itself. Built per request — it is cheap and depends on nothing mutable.
    router.get("/openapi.json", (c) => c.json(buildOpenApiDocument(PUBLIC_ORIGIN || undefined)));
    router.get("/docs", (c) => c.html(renderDocsHtml(buildOpenApiDocument(PUBLIC_ORIGIN || undefined))));

    for (const route of ROUTES) {
        router.on(route.method.toUpperCase(), toHonoPath(route.path), async (c) => await handle(route, c));
    }

    // Anything else under /api/v1 answers in the API's own error shape, not the app's.
    router.all("*", (c) => errorResponse(new PublicApiError("not_found", `No route ${c.req.method} ${new URL(c.req.url).pathname}.`), requestIdOf(c)));

    return router;
};

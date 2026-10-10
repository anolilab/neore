import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { MiddlewareHandler } from "hono";

import type { AppEnv, HonoEnv } from "./env.js";
import { asBindingCallerEnv } from "./lib/binding-caller.js";
import { logger } from "./lib/logger.js";
import { internalAuth } from "./middleware/auth.js";
import { contentSafetyMiddleware } from "./middleware/content-safety.js";
import { inputValidationMiddleware } from "./middleware/input-validation.js";
import loggerMiddleware from "./middleware/logger.js";
import { corsMiddleware, securityMiddleware } from "./middleware/security.js";
import { telemetryMiddleware } from "./middleware/telemetry.js";
import { GATEWAY_MODELS } from "./models.js";
import { assertMockLlmAllowed } from "./providers/mock-model.js";
import { PricingService } from "./providers/pricing.js";
import { handleMusicRenderBatch } from "./queue/music-render-consumer.js";
import { handleVideoRenderBatch } from "./queue/video-render-consumer.js";
import { healthRouter } from "./routes/health.js";
import { adminTierPoolsRouter } from "./routes/internal/admin-tier-pools.js";
import { canaryRouter } from "./routes/internal/canary.js";
import { generateRouter } from "./routes/internal/generate.js";
import { keysRouter } from "./routes/internal/keys.js";
import { modelProxyRouter } from "./routes/internal/model-proxy.js";
import { notificationRulesRouter } from "./routes/internal/notification-rules.js";
import { routeRouter } from "./routes/internal/route.js";
import { speechRouter } from "./routes/internal/speech.js";
import { streamRouter } from "./routes/internal/stream.js";
import { webhooksRouter } from "./routes/internal/webhooks.js";
import { cacheRouter } from "./routes/v1/cache.js";
import { chatRouter } from "./routes/v1/chat.js";
import { clientStreamRouter } from "./routes/v1/client-stream.js";
import { completionsRouter } from "./routes/v1/completions.js";
import { embeddingsRouter } from "./routes/v1/embeddings.js";
import { eventsRouter } from "./routes/v1/events.js";
import { modelsRouter } from "./routes/v1/models.js";
import { musicRouter } from "./routes/v1/music.js";
import type { MusicRenderMessage } from "./routes/v1/music-types.js";
import { rateLimitsRouter } from "./routes/v1/rate-limits.js";
import { realtimeRouter } from "./routes/v1/realtime.js";
import { usageRouter } from "./routes/v1/usage.js";
import { videoRouter } from "./routes/v1/video.js";
import type { VideoRenderMessage } from "./routes/v1/video-types.js";
import { recomputeTierPools } from "./routing/tier-assignment.js";
import { UsageAggregator } from "./usage/aggregator.js";

export const app = new OpenAPIHono<HonoEnv>();

// Global middleware
// First, so `MOCK_LLM` leaking into production fails every request — health
// checks included — instead of serving canned replies.
app.use("*", async (c, next) => {
    assertMockLlmAllowed(c.env);
    await next();
});
app.use("*", securityMiddleware);
app.use("*", corsMiddleware);
// Telemetry must run before any business middleware so the root span
// covers the full request lifecycle (including auth/rate-limit failures).
app.use("*", telemetryMiddleware);
app.use("*", loggerMiddleware);

// Rate limiting is applied inside completionsRouter (after bearerAuth) so that
// userId/userTier are available for the per-user KV counter check.

// Error handler
app.onError(async (error, c) => {
    const isDevelopment = c.env.NODE_ENV !== "production";

    logger.error(error.message, isDevelopment ? error : undefined);

    return c.json(
        {
            details: isDevelopment ? error.stack : undefined,
            error: error.message ?? "Internal Server Error",
        },
        500,
    );
});

// Routes — Health
app.route("/", healthRouter);

// Every `/internal/*` path is binding-only (`internalAuth`, see `InternalApi`
// below) — blanket, so a new internal route cannot forget its guard. The routes
// keep their own `internalAuth` too.
app.use("/internal/*", internalAuth);

// Internal routes: the binding check FIRST so internet callers cannot reach the
// content-safety classifier (which would otherwise act as a banned-word oracle)
// or the JSON parser (DoS surface). Input validation + content safety run only
// after the binding check has accepted the request.
app.use("/internal/stream", internalAuth, inputValidationMiddleware, contentSafetyMiddleware);
app.use("/internal/generate", internalAuth, inputValidationMiddleware, contentSafetyMiddleware);
// THE content-safety enforcement point for chat: `/v1/chat*` only forwards to the
// backend, whose every model call returns here. `content-safety.test.ts` pins it.
app.use("/internal/model/proxy", internalAuth, inputValidationMiddleware, contentSafetyMiddleware);

// Routes — Internal API (Backend -> Gateway, service binding only)
app.route("/", generateRouter);
app.route("/", streamRouter);
app.route("/", routeRouter);
app.route("/", modelProxyRouter);
app.route("/", speechRouter);
app.route("/", webhooksRouter);
app.route("/", keysRouter);
app.route("/", canaryRouter);
app.route("/", notificationRulesRouter);
app.route("/", adminTierPoolsRouter);

// Routes — Client-facing (stream token auth or user JWT)
app.route("/", chatRouter);
app.route("/", clientStreamRouter);
app.route("/", realtimeRouter);

// Routes — SaaS API + Dashboard (Bearer auth; a few backend-only routes are binding-only)
app.route("/", cacheRouter);
app.route("/", completionsRouter);
app.route("/", embeddingsRouter);
app.route("/", modelsRouter);
app.route("/", rateLimitsRouter);
app.route("/", usageRouter);
app.route("/", eventsRouter);
app.route("/", videoRouter);
app.route("/", musicRouter);

// OpenAPI docs (dev only)
app.get("/openapi.json", (c) => {
    if (c.env.NODE_ENV === "production") {
        return c.json({ error: "Not found" }, 404);
    }

    return c.json(
        app.getOpenAPIDocument({
            info: {
                description: "LLM Gateway Service — proxies all LLM API calls with token counting, cost tracking, smart routing, and usage analytics.",
                title: "LLM Gateway API",
                version: "1.0.0",
            },
            openapi: "3.1.0",
        }),
    );
});

// Swagger UI (dev only) — gated symmetrically with /openapi.json so the
// relaxed CSP branch in security middleware is never reachable in prod.
// The production gate is its own middleware rather than a branch inside the
// handler: mixing "return a 404 response" and "delegate to a middleware that
// may return void" in one handler produces a union Hono's route signature
// cannot accept, and casting it away would hide a genuine mismatch.
app.use("/doc", async (c, next) => {
    if (c.env.NODE_ENV === "production") {
        return c.json({ error: "Not found" }, 404);
    }

    // `swaggerUI` is typed against Hono's default `Env`, not this app's `HonoEnv`,
    // and as a middleware it may resolve to `void`. This route always answers.
    return (swaggerUI({ url: "/openapi.json" }) as unknown as MiddlewareHandler<HonoEnv>)(c, next) as Promise<Response>;
});
app.get("/doc", swaggerUI({ url: "/openapi.json" }));

// Empty favicon to suppress 404
app.get("/favicon.ico", (c) => c.body(null, 204));

/**
 * The backend's way in: a NAMED entrypoint, bound by the backend as
 * `SERVICE_LLM_GATEWAY` (`backend/lunora.config.ts`, `alchemy.run.ts`).
 *
 * A named entrypoint is reachable only through a service binding — no route or
 * `workers.dev` URL serves it — so the requests it runs are the backend's by
 * construction. It runs the same app as the public `fetch` below, with an env
 * marked by `asBindingCallerEnv`, and that marker is what `internalAuth` admits
 * `/internal/*` on. The public handler never carries it.
 */
export class InternalApi extends WorkerEntrypoint<AppEnv> {
    override async fetch(request: Request): Promise<Response> {
        return app.fetch(request, asBindingCallerEnv(this.env), this.ctx);
    }
}

// Cloudflare Workers export — includes fetch, scheduled, and queue handlers.
export default {
    fetch: app.fetch,

    /**
     * Queue consumer dispatch for background render jobs.
     *
     * The Worker is bound to multiple queues (video + DLQ, music + DLQ) so
     * the runtime invokes this single handler for all of them. We inspect
     * `batch.queue` to route to the right consumer — each one is responsible
     * for its own DLQ-vs-primary distinction and telemetry namespace.
     */
    async queue(batch: MessageBatch<VideoRenderMessage | MusicRenderMessage>, env: AppEnv, context: ExecutionContext): Promise<void> {
        if (batch.queue.startsWith("llm-gateway-music-renders")) {
            await handleMusicRenderBatch(batch as MessageBatch<MusicRenderMessage>, env, context);

            return;
        }

        await handleVideoRenderBatch(batch as MessageBatch<VideoRenderMessage>, env, context);
    },

    // Scheduled cron handler for background maintenance tasks.
    // Configure crons in wrangler.jsonc under "triggers".
    async scheduled(event: ScheduledEvent, env: AppEnv, _context: ExecutionContext): Promise<void> {
        switch (event.cron) {
            // Daily at 02:00 UTC — refresh model pricing from models.dev
            case "0 2 * * *": {
                const pricing = new PricingService(env);

                await pricing.refreshAll();
                logger.info("[Cron] Pricing refresh complete");
                break;
            }

            // Weekly Sunday 04:00 UTC — recompute tier model pools from the
            // current candidate catalogue + models.dev pricing. Each tier's
            // pool is scored on cost, context window, and capabilities so
            // new/retired models flow into the auto-routing decisions
            // without a code deploy. Result is persisted to PRICING_KV
            // (key: `tier_pools:v1`, 14d TTL).
            case "0 4 * * 0": {
                try {
                    const snapshot = await recomputeTierPools(env, GATEWAY_MODELS);

                    logger.info(
                        `[Cron] Tier pools recomputed: simple=${snapshot.pools.simple.length}, standard=${snapshot.pools.standard.length}, complex=${snapshot.pools.complex.length}, reasoning=${snapshot.pools.reasoning.length}`,
                    );
                } catch (error) {
                    logger.error("[Cron] Tier pool recomputation failed", error instanceof Error ? error : undefined);
                }

                break;
            }

            // Daily at 00:05 UTC — aggregate usage data + cleanup old logs
            case "5 0 * * *": {
                const aggregator = new UsageAggregator(env);

                await aggregator.materializeDailyAggregates();
                await aggregator.cleanupOldUsageLogs();
                logger.info("[Cron] Daily usage aggregation complete");
                break;
            }

            // Every 5 minutes — reset expired circuit breakers
            case "*/5 * * * *": {
                try {
                    await env.USAGE_DB.prepare(
                        "UPDATE provider_health SET status = 'healthy', circuit_breaker_until = NULL, updated_at = datetime('now') WHERE circuit_breaker_until IS NOT NULL AND circuit_breaker_until < datetime('now')",
                    ).run();
                } catch {
                    // Non-critical
                }

                break;
            }

            default: {
                logger.warn(`[Cron] Unknown cron expression: ${event.cron}`);
            }
        }
    },
};

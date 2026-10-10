/**
 * OpenAI Realtime API WebSocket Proxy
 *
 * GET /v1/realtime?model=gpt-4o-realtime-preview
 *
 * Upgrades to a WebSocket and bidirectionally relays all messages to/from the
 * OpenAI Realtime API. Tracks session usage and writes to `usage_log` on close.
 *
 * Auth:   Bearer token (gk_*) validated before upgrade.
 * Limit:  2 concurrent sessions per free-tier user, 10 per pro user.
 * Usage:  Captured from `response.done` events (input_tokens / output_tokens).
 * Pricing (v1 estimates): gpt-4o-realtime: $0.06/min audio input, $0.24/min output.
 */

import { OpenAPIHono } from "@hono/zod-openapi";

import type { HonoEnv } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { bearerAuth } from "../../middleware/auth.js";

/** Supported realtime models */
const REALTIME_MODELS = new Set(["gpt-4o-mini-realtime-preview", "gpt-4o-realtime-preview"]);

/** Upstream OpenAI Realtime WebSocket base URL */
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

/** Concurrent session limits by tier */
const CONCURRENT_LIMITS: Record<string, number> = {
    enterprise: 50,
    free: 2,
    pro: 10,
};

/**
 * Per-token cost in microdollars (1 microdollar = 1e-6 USD).
 * $0.06 per 1k tokens = 60_000 microdollars per 1k = 60 microdollars per token.
 * $0.24 per 1k tokens = 240 microdollars per token.
 */
const REALTIME_INPUT_COST_PER_TOKEN_MICRODOLLARS = 60;
const REALTIME_OUTPUT_COST_PER_TOKEN_MICRODOLLARS = 240;

// ---------------------------------------------------------------------------
// KV helpers — concurrent session tracking
//
// Each active session is registered as its own KV key with TTL. We count by
// listing keys under the user's prefix. This is more accurate than a counter
// (which can drift on crashes) but still subject to KV eventual consistency:
// in a tight burst, multiple connections might both see "under limit" before
// either has registered. The TTL acts as a backstop.
//
// For strict concurrency, migrate to a Durable Object with atomic state.
// ---------------------------------------------------------------------------

const SESSION_TTL_SECONDS = 1800; // 30 min — relies on heartbeat refresh

const sessionPrefix = (userId: string) => `realtime:session:${userId}:`;
const sessionKey = (userId: string, sessionId: string) => `${sessionPrefix(userId)}${sessionId}`;

async function countActiveSessions(kv: KVNamespace, userId: string): Promise<number> {
    const list = await kv.list({ limit: 100, prefix: sessionPrefix(userId) });

    return list.keys.length;
}

async function registerSession(kv: KVNamespace, userId: string, sessionId: string): Promise<void> {
    await kv.put(sessionKey(userId, sessionId), String(Date.now()), { expirationTtl: SESSION_TTL_SECONDS });
}

async function unregisterSession(kv: KVNamespace, userId: string, sessionId: string): Promise<void> {
    await kv.delete(sessionKey(userId, sessionId));
}

// ---------------------------------------------------------------------------
// Usage log helper
// ---------------------------------------------------------------------------

async function logRealtimeSession(
    database: D1Database,
    options: {
        apiKeyId: string;
        costMicrodollars: number;
        durationMs: number;
        inputTokens: number;
        model: string;
        orgId: string | undefined;
        outputTokens: number;
        requestId: string;
        userId: string;
    },
): Promise<void> {
    await database
        .prepare(
            `INSERT INTO usage_log
             (id, request_id, user_id, org_id, model_id, provider, model_api_id,
              prompt_tokens, completion_tokens, cost_microdollars, latency_ms,
              is_streaming, finish_reason, source, api_key_id, session_type, duration_ms, created_at)
             VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, ?, ?, ?, 1, 'stop', 'saas', ?, 'realtime', ?, datetime('now'))`,
        )
        .bind(
            crypto.randomUUID(),
            options.requestId,
            options.userId,
            options.orgId ?? null,
            options.model,
            options.model,
            options.inputTokens,
            options.outputTokens,
            options.costMicrodollars,
            options.durationMs,
            options.apiKeyId,
            options.durationMs,
        )
        .run();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const realtimeRouter = new OpenAPIHono<HonoEnv>();

/**
 * GET /v1/realtime?model=gpt-4o-realtime-preview
 *
 * Must be an HTTP Upgrade request (Upgrade: websocket).
 * Bearer token is validated synchronously before the upgrade is accepted.
 */
realtimeRouter.get("/v1/realtime", bearerAuth, async (c) => {
    // Verify this is a WebSocket upgrade request
    const upgradeHeader = c.req.header("Upgrade");

    if (upgradeHeader?.toLowerCase() !== "websocket") {
        return c.json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const model = c.req.query("model") ?? "gpt-4o-realtime-preview";

    if (!REALTIME_MODELS.has(model)) {
        return c.json({ error: `Unsupported realtime model. Supported: ${[...REALTIME_MODELS].join(", ")}` }, 400);
    }

    const userId = c.get("userId");
    const userTier = c.get("userTier") ?? "free";
    const orgId = c.get("orgId");
    const apiKeyId = c.get("apiKeyId");
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    const usesOwnKeys = c.get("usesOwnKeys") ?? false;

    // Resolve the OpenAI API key to use for the upstream connection.
    // SECURITY NOTE: The BYOK path receives the key via the
    // `X-User-OpenAI-Key` header. The header value MUST NEVER be logged
    // and any tracing/observability layer must scrub it. The long-term
    // path is to fetch the encrypted BYOK key from the backend via an
    // HMAC-signed call (matching the chat-path pattern). Until that
    // refactor lands, this header path is the only fallback.
    const byokHeader = c.req.header("X-User-OpenAI-Key");
    const openaiKey = usesOwnKeys ? byokHeader : c.env.OPENAI_API_KEY;

    if (!openaiKey) {
        return c.json({ error: "OpenAI API key not available for realtime sessions" }, 400, { "Cache-Control": "no-store" });
    }

    if (usesOwnKeys && !byokHeader) {
        return c.json({ error: "Missing X-User-OpenAI-Key header for BYOK realtime session" }, 400, { "Cache-Control": "no-store" });
    }

    // Concurrent session rate limiting — register first, then count.
    // This narrows the TOCTOU window: any racing connection that registers
    // sees its own slot in the count. KV eventual consistency means a tight
    // burst can still allow a small number of overlimit sessions, which we
    // accept in exchange for not requiring a Durable Object here.
    const maxConcurrent = CONCURRENT_LIMITS[userTier] ?? CONCURRENT_LIMITS["free"]!;
    const sessionId = crypto.randomUUID();

    await registerSession(c.env.RATE_LIMIT_KV, userId, sessionId);

    const currentCount = await countActiveSessions(c.env.RATE_LIMIT_KV, userId);

    if (currentCount > maxConcurrent) {
        await unregisterSession(c.env.RATE_LIMIT_KV, userId, sessionId);

        return c.json({ error: `Concurrent session limit reached (${maxConcurrent} for ${userTier} tier)` }, 429);
    }

    // Establish upstream WebSocket to OpenAI Realtime API
    const upstreamUrl = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`;
    let upstreamResp: Response;

    try {
        upstreamResp = await fetch(upstreamUrl, {
            headers: {
                Authorization: `Bearer ${openaiKey}`,
                Connection: "Upgrade",
                "OpenAI-Beta": "realtime=v1",
                Upgrade: "websocket",
            },
        });
    } catch (error) {
        // Decrement on upstream connect failure so the slot is reclaimed.
        await unregisterSession(c.env.RATE_LIMIT_KV, userId, sessionId);
        logger.error("[Realtime] Failed to connect to OpenAI upstream", error);

        return c.json({ error: "Failed to connect to upstream realtime service" }, 502);
    }

    if (upstreamResp.status !== 101) {
        await unregisterSession(c.env.RATE_LIMIT_KV, userId, sessionId);
        const body = await upstreamResp.text().catch(() => "");

        logger.error(`[Realtime] Upstream returned ${upstreamResp.status}: ${body}`);

        return c.json({ error: "Upstream realtime service rejected connection" }, 502);
    }

    // Cloudflare-specific: extract WebSocket from response
    const upstream = (upstreamResp as unknown as { webSocket: WebSocket | null }).webSocket;

    if (!upstream) {
        await unregisterSession(c.env.RATE_LIMIT_KV, userId, sessionId);

        return c.json({ error: "Upstream did not return a WebSocket" }, 502);
    }

    upstream.accept();

    // Create client-facing WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    server.accept();

    // Session state for usage tracking
    const sessionStart = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;

    // Run cleanup at most once across close/error paths so the slot is
    // always reclaimed even if the upstream/client errors instead of
    // closing cleanly.
    let isCleanupDone = false;
    const onClose = async () => {
        if (isCleanupDone) return;

        isCleanupDone = true;

        const durationMs = Date.now() - sessionStart;
        const costMicrodollars = inputTokens * REALTIME_INPUT_COST_PER_TOKEN_MICRODOLLARS + outputTokens * REALTIME_OUTPUT_COST_PER_TOKEN_MICRODOLLARS;

        await Promise.allSettled([
            unregisterSession(c.env.RATE_LIMIT_KV, userId, sessionId),
            logRealtimeSession(c.env.USAGE_DB, {
                apiKeyId,
                costMicrodollars: Math.round(costMicrodollars),
                durationMs,
                inputTokens,
                model,
                orgId,
                outputTokens,
                requestId,
                userId,
            }),
        ]);
    };

    // Relay: client -> upstream
    server.addEventListener("message", (event_: MessageEvent) => {
        try {
            upstream.send(event_.data as string | ArrayBuffer);
        } catch {
            // Upstream may have closed
        }
    });

    server.addEventListener("close", () => {
        try {
            upstream.close();
        } catch {
            /* already closed */
        }

        c.executionCtx.waitUntil(onClose());
    });

    server.addEventListener("error", () => {
        try {
            upstream.close();
        } catch {
            /* already closed */
        }

        c.executionCtx.waitUntil(onClose());
    });

    // Relay: upstream -> client, and parse usage events
    upstream.addEventListener("message", (event_: MessageEvent) => {
        // Parse response.done to capture token usage
        if (typeof event_.data === "string") {
            try {
                const message = JSON.parse(event_.data) as {
                    response?: {
                        usage?: {
                            input_tokens?: number;
                            output_tokens?: number;
                        };
                    };
                    type?: string;
                };

                if (message.type === "response.done" && message.response?.usage) {
                    inputTokens += message.response.usage.input_tokens ?? 0;
                    outputTokens += message.response.usage.output_tokens ?? 0;
                }
            } catch {
                // Non-JSON frame — ignore
            }
        }

        try {
            server.send(event_.data as string | ArrayBuffer);
        } catch {
            // Client may have disconnected
        }
    });

    upstream.addEventListener("close", () => {
        try {
            server.close();
        } catch {
            /* already closed */
        }

        c.executionCtx.waitUntil(onClose());
    });

    upstream.addEventListener("error", () => {
        try {
            server.close();
        } catch {
            /* already closed */
        }

        c.executionCtx.waitUntil(onClose());
    });

    logger.info(`[Realtime] Session started user=${userId} model=${model} request=${requestId}`);

    // Return 101 Switching Protocols with the client WebSocket
    return new Response(null, {
        status: 101,
        webSocket: client,
    } as unknown as ResponseInit);
});

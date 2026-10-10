/**
 * Gateway-first chat routes — all client chat HTTP requests go through here.
 *
 * Routes:
 *   POST /v1/chat                         — Start a chat (create thread, schedule agent)
 *   POST /v1/chat/media                   — Media generation (image/video)
 *   POST /v1/chat/edit                    — Edit and regenerate a message
 *   POST /v1/chat/improve-prompt          — Optimize a user prompt
 *   POST /v1/chat/optimize-system-prompt  — Optimize a system prompt
 *   POST /v1/chat/iterate-prompt          — Refine a previously optimized prompt
 *   POST /v1/prompts/optimize             — Optimize a saved prompt template
 *
 * All routes: validate input, rate-limit per user,
 * HMAC-sign, forward to the Lunora backend, and return the JSON response.
 */
import type { JSONObject } from "@ai-sdk/provider";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

import type { HonoEnv } from "../../env.js";
import { canonicalPathAndQuery } from "../../lib/canonical-query.js";
import { chatInputValidationMiddleware } from "../../middleware/input-validation.js";
import { parseTierOverride, TIER_OVERRIDE_HEADER } from "../../routing/tier-override.js";

const chatRouter = new OpenAPIHono<HonoEnv>();

// Every route on this router runs the same input validation before reaching the
// forwarder. Registering it once keeps the per-route declarations to the handler logic.
//
// Content safety is deliberately NOT here: this router only forwards to the backend,
// and every model call the backend then makes comes back through
// `/internal/model/proxy`, where `contentSafetyMiddleware` checks the user text
// (see the `/internal/*` registrations in `src/index.ts`). That is the one
// enforcement point; the middleware ignores non-`/internal/` paths, so registering
// it here only looked like a second check.
chatRouter.use("*", chatInputValidationMiddleware);

// ── HMAC signing helpers ─────────────────────────────────────────────────────

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** HTTP status codes this route relays verbatim from the upstream backend. */
type UpstreamErrorStatus = 500 | 502 | 503;

const signRequest = async (method: string, url: string, body: ArrayBuffer, secret: string): Promise<{ "X-Signature": string; "X-Timestamp": string }> => {
    const timestamp = Date.now().toString();
    // Include canonical query in the signed message so query parameters
    // are authenticated within the replay window (matches the backend signer
    // and gateway `verifyHmac`).
    const u = new URL(url);
    const pathAndQuery = canonicalPathAndQuery(u);
    const bodyHash = await sha256Hex(body);
    const message = `${method}\n${pathAndQuery}\n${timestamp}\n${bodyHash}`;
    const signature = await hmacSha256Hex(secret, message);

    return { "X-Signature": signature, "X-Timestamp": timestamp };
};

// ── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Generic per-user rate limiter using KV. Identifies users by JWT hash
 * (avoids decoding the token). Returns { ok: true } if under limit.
 */
const checkRateLimit = async (
    kv: KVNamespace | undefined,
    authHeader: string,
    prefix: string,
    limit: number,
): Promise<{ limit: number; ok: boolean; retryAfter?: number }> => {
    if (!kv) return { limit, ok: true };

    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(authHeader));
    const userHash = [...new Uint8Array(hash)]
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    const minuteBucket = Math.floor(Date.now() / 60_000);
    const key = `rl:${prefix}:${userHash}:${minuteBucket}`;

    const current = Number(await kv.get(key)) || 0;

    if (current >= limit) {
        const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);

        return { limit, ok: false, retryAfter };
    }

    await kv.put(key, String(current + 1), { expirationTtl: 120 });

    return { limit, ok: true };
};

const CHAT_RPM = 30;
const PROMPT_RPM = 15;

// ── Shared forwarding helper ─────────────────────────────────────────────────

/**
 * Forward a request to a Lunora backend HTTP endpoint with HMAC signing.
 * Handles auth check, rate limiting, signing, error passthrough.
 */
const forwardToBackend = async (
    c: Context<HonoEnv>,
    backendPath: string,
    rateLimitPrefix: string,
    rateLimitRpm: number,
    extraHeaders: Record<string, string> = {},
): Promise<Response> => {
    const lunoraUrl = c.env.LUNORA_URL;
    const signingSecret = c.env.SIGNING_SECRET;
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
        return c.json({ error: "Missing Authorization header" }, 401);
    }

    if (!lunoraUrl || !signingSecret) {
        return c.json({ error: "Gateway not configured" }, 500);
    }

    const rateLimit = await checkRateLimit(c.env.RATE_LIMIT_KV, authHeader, rateLimitPrefix, rateLimitRpm);

    if (!rateLimit.ok) {
        return c.json(
            { error: { code: "RATE_LIMITED", message: `Rate limit exceeded: ${rateLimit.limit} requests per minute`, retryAfter: rateLimit.retryAfter } },
            { headers: { "Retry-After": String(rateLimit.retryAfter ?? 60) }, status: 429 },
        );
    }

    const rawBody = await c.req.text();
    const bodyBytes = new TextEncoder().encode(rawBody);

    const targetUrl = `${lunoraUrl}${backendPath}`;
    const sigHeaders = await signRequest("POST", targetUrl, bodyBytes.buffer as ArrayBuffer, signingSecret);

    const backendResponse = await fetch(targetUrl, {
        body: rawBody,
        headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
            ...sigHeaders,
            ...extraHeaders,
        },
        method: "POST",
    });

    if (!backendResponse.ok) {
        const errorBody = await backendResponse.text();
        const isProduction = c.env.NODE_ENV === "production";

        // Always log raw upstream errors server-side for debugging.
        console.error("[gateway:chat] Upstream backend error", {
            body: errorBody,
            path: backendPath,
            status: backendResponse.status,
        });

        // 4xx errors are caller-actionable (bad input, auth, not found) so the
        // body is safe to surface. 5xx errors come from backend internals and may
        // include stack traces, table names, or query plans — sanitize in prod.
        const { status } = backendResponse;
        const isClientError = status >= 400 && status < 500;

        if (isClientError) {
            try {
                return c.json(JSON.parse(errorBody), status as 400 | 401 | 403 | 404);
            } catch {
                return c.json({ error: errorBody || "Request failed" }, status as 400 | 401 | 403 | 404);
            }
        }

        // 5xx — sanitize in production, pass through in dev for debugging.
        if (isProduction) {
            return c.json({ error: "Upstream service error" }, status as UpstreamErrorStatus);
        }

        try {
            return c.json(JSON.parse(errorBody), status as UpstreamErrorStatus);
        } catch {
            return c.json({ error: errorBody || "Request failed" }, status as UpstreamErrorStatus);
        }
    }

    return c.json((await backendResponse.json()) as JSONObject, 200);
};

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * Resolve the public origin to advertise back to clients.
 * MUST come from the trusted env var, not the request URL — `c.req.url`
 * reflects the attacker-controlled `Host` header in Cloudflare Workers, so
 * deriving origin from it would let an attacker trick clients into streaming
 * from an arbitrary origin where the bearer-equivalent stream token gets
 * replayed.
 */
const resolvePublicGatewayOrigin = (c: Context<HonoEnv>): string | null => {
    const configured = c.env.PUBLIC_GATEWAY_URL?.trim();

    if (configured) {
        try {
            return new URL(configured).origin;
        } catch {
            console.error("[gateway:chat] Invalid PUBLIC_GATEWAY_URL — must be a parseable URL", { configured });

            return null;
        }
    }

    // Allow Host-header fallback ONLY in non-production for local dev / preview.
    if (c.env.NODE_ENV !== "production") {
        try {
            return new URL(c.req.url).origin;
        } catch {
            return null;
        }
    }

    return null;
};

/** POST /v1/chat — Start a chat (create thread + schedule agent) */
chatRouter.post("/v1/chat", async (c) => {
    // Shape-validate the `x-gateway-tier` header (forwarded to the backend which
    // re-issues it on `/internal/route` where the real userTier permission
    // check happens). We probe with `admin` here so this catches obviously-
    // malformed alias values without saving the round-trip for legitimately
    // disallowed tiers.
    const tierHeaderRaw = c.req.header(TIER_OVERRIDE_HEADER);
    const extraHeaders: Record<string, string> = {};

    if (tierHeaderRaw) {
        const probe = parseTierOverride(tierHeaderRaw, "admin");

        if (probe.error) {
            return c.json({ error: probe.error }, 400);
        }

        extraHeaders[TIER_OVERRIDE_HEADER] = tierHeaderRaw;
    }

    const response = await forwardToBackend(c, "/chat/start", "chat", CHAT_RPM, extraHeaders);

    // Enrich with gateway URL so the client knows where to stream from.
    if (response.status === 200) {
        const body = (await response.json()) as JSONObject;
        const gatewayOrigin = resolvePublicGatewayOrigin(c);

        if (!gatewayOrigin) {
            console.error("[gateway:chat] PUBLIC_GATEWAY_URL is not configured in production — cannot advertise stream origin");

            return c.json({ error: "Gateway not configured" }, 500);
        }

        return c.json({ ...body, gatewayUrl: gatewayOrigin }, 200);
    }

    return response;
});

/** POST /v1/chat/media — Media generation (image/video) */
chatRouter.post("/v1/chat/media", async (c) => forwardToBackend(c, "/chat/media", "chat", CHAT_RPM));

/** POST /v1/chat/edit — Edit and regenerate a message */
chatRouter.post("/v1/chat/edit", async (c) => forwardToBackend(c, "/chat/edit", "chat", CHAT_RPM));

/** POST /v1/chat/improve-prompt — Improve a user prompt */
chatRouter.post("/v1/chat/improve-prompt", async (c) => forwardToBackend(c, "/chat/improve-prompt", "prompt", PROMPT_RPM));

/** POST /v1/chat/optimize-system-prompt — Optimize a system prompt */
chatRouter.post("/v1/chat/optimize-system-prompt", async (c) => forwardToBackend(c, "/chat/optimize-system-prompt", "prompt", PROMPT_RPM));

/** POST /v1/chat/iterate-prompt — Refine a previously optimized prompt */
chatRouter.post("/v1/chat/iterate-prompt", async (c) => forwardToBackend(c, "/chat/iterate-prompt", "prompt", PROMPT_RPM));

/** POST /v1/prompts/optimize — Optimize a prompt template */
chatRouter.post("/v1/prompts/optimize", async (c) => forwardToBackend(c, "/prompts/optimize", "prompt", PROMPT_RPM));

export { chatRouter };

/**
 * Dual authentication middleware for the LLM Gateway.
 *
 * 1. Internal Backend -> Gateway calls: admitted only through the `InternalApi`
 *    service-binding entrypoint (`internalAuth`).
 * 2. Bearer token for SaaS API calls (Authorization: Bearer gk_...)
 */
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";
import { isBindingCall } from "../lib/binding-caller.js";

interface ApiKeyCacheRow {
    expires_at: string;
    is_active: number;
    key_hash: string;
    org_id: string | null;
    rate_limit_rpm: number;
    tier: string;
    user_id: string;
    uses_own_keys: number;
}

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Admits a request to an internal route (`/internal/*`, and the few `/v1/*`
 * routes only the backend calls) ONLY when it arrived through the `InternalApi`
 * entrypoint — a Cloudflare service binding from the backend.
 *
 * This replaced HMAC request signing. The gateway is public, so its default
 * `fetch` handler serves the internet; a named entrypoint is served on no route
 * and no `workers.dev`, so only a binding reaches it (`lib/binding-caller.ts`).
 * Anything else gets a 404 rather than a 401 — the internal surface is not
 * advertised to the internet at all.
 */
export const internalAuth = createMiddleware<HonoEnv>(async (c, next) => {
    if (!isBindingCall(c.env)) {
        return c.json({ error: "Not found" }, 404);
    }

    await next();

    return undefined;
});

/**
 * Bearer token authentication for SaaS API routes (/v1/*), checked against the
 * D1 `api_key_cache`. No `gk_*` keys are issued, and nothing writes that cache
 * today, so every token is refused in practice. The backend fallback that used
 * to fill it was removed: it called a route the backend does not serve.
 */
export const bearerAuth = createMiddleware<HonoEnv>(async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
        return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.slice(7);

    if (!token.startsWith("gk_")) {
        return c.json({ error: "Invalid API key format. Expected gk_..." }, 401);
    }

    // Hash the token — never store or compare raw keys
    const keyHash = await sha256Hex(new TextEncoder().encode(token).buffer as ArrayBuffer);

    try {
        const cached = await c.env.USAGE_DB.prepare("SELECT * FROM api_key_cache WHERE key_hash = ? AND is_active = 1 AND expires_at > datetime('now')")
            .bind(keyHash)
            .first<ApiKeyCacheRow>();

        if (!cached) {
            return c.json({ error: "Invalid API key" }, 401);
        }

        c.set("userId", cached.user_id);
        c.set("userTier", cached.tier);
        c.set("orgId", cached.org_id ?? undefined);
        c.set("apiKeyId", keyHash);
        c.set("usesOwnKeys", cached.uses_own_keys === 1);
        await next();

        return undefined;
    } catch {
        return c.json({ error: "Authentication service unavailable" }, 503);
    }
});

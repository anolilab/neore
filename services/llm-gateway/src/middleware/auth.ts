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

/** Cache API key lookups for 5 minutes */
// Bounded revocation window: a revoked gk_* key keeps working for up to
// this many seconds after a customer hits the revoke endpoint. 5 minutes
// (the previous default) is too long for compromised-key remediation.
const API_KEY_CACHE_TTL_S = 60;

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

/**
 * Bearer token authentication for SaaS API routes (/v1/*).
 * Validates gk_* tokens against D1 api_key_cache with a backend fallback.
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
    const database = c.env.USAGE_DB;

    // Step 1: Check D1 api_key_cache
    try {
        const cached = await database
            .prepare("SELECT * FROM api_key_cache WHERE key_hash = ? AND is_active = 1 AND expires_at > datetime('now')")
            .bind(keyHash)
            .first<ApiKeyCacheRow>();

        if (cached) {
            c.set("userId", cached.user_id);
            c.set("userTier", cached.tier);
            c.set("orgId", cached.org_id ?? undefined);
            c.set("apiKeyId", keyHash);
            c.set("usesOwnKeys", cached.uses_own_keys === 1);
            await next();

            return undefined;
        }
    } catch {
        // D1 error — fall through to backend validation
    }

    // Step 2: backend fallback — validate key against the auth source of truth
    const lunoraUrl = c.env.LUNORA_URL;
    const signingSecret = c.env.SIGNING_SECRET;

    if (!lunoraUrl || !signingSecret) {
        return c.json({ error: "Authentication service not configured" }, 503);
    }

    try {
        const body = JSON.stringify({ keyHash });
        const timestamp = Date.now().toString();
        const bodyHashHex = await sha256Hex(new TextEncoder().encode(body).buffer as ArrayBuffer);
        // No query string on /gateway/validate-key, so canonical path+query equals pathname.
        const message = `POST\n/gateway/validate-key\n${timestamp}\n${bodyHashHex}`;
        const signature = await hmacSha256Hex(signingSecret, message);

        const response = await fetch(`${lunoraUrl}/gateway/validate-key`, {
            body,
            headers: {
                "Content-Type": "application/json",
                "X-Signature": signature,
                "X-Timestamp": timestamp,
            },
            method: "POST",
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            await response.body?.cancel();

            return c.json({ error: "Invalid API key" }, 401);
        }

        const result = (await response.json()) as {
            isActive: boolean;
            orgId?: string;
            rateLimitRpm: number;
            tier: string;
            userId: string;
            usesOwnKeys: boolean;
        };

        if (!result.isActive) {
            return c.json({ error: "API key has been deactivated" }, 401);
        }

        // Cache in D1 for subsequent requests
        c.executionCtx.waitUntil(
            database
                .prepare(
                    `INSERT OR REPLACE INTO api_key_cache (key_hash, user_id, org_id, tier, rate_limit_rpm, is_active, uses_own_keys, cached_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now', '+${API_KEY_CACHE_TTL_S} seconds'))`,
                )
                .bind(keyHash, result.userId, result.orgId ?? null, result.tier, result.rateLimitRpm, result.usesOwnKeys ? 1 : 0)
                .run()
                .catch(() => {}),
        );

        c.set("userId", result.userId);
        c.set("userTier", result.tier);
        c.set("orgId", result.orgId ?? undefined);
        c.set("apiKeyId", keyHash);
        c.set("usesOwnKeys", result.usesOwnKeys);
        await next();

        return undefined;
    } catch {
        return c.json({ error: "Authentication service unavailable" }, 503);
    }
});

import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";

const MAX_AGE_RE = /\bmax-age=\d+/u;
const NO_STORE_RE = /\bno-store\b/u;

/** A handler-set Cache-Control that grants a lifetime and does not forbid storing. */
export const isCacheableByHandler = (value: string | null): boolean => !!value && MAX_AGE_RE.test(value) && !NO_STORE_RE.test(value);

export const securityMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const requestId = crypto.randomUUID();

    c.set("requestId", requestId);

    await next();

    c.res.headers.set("X-Request-Id", requestId);
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

    const path = new URL(c.req.url).pathname;

    if (path === "/doc" || path === "/openapi.json") {
        c.res.headers.set(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net",
        );
    } else {
        c.res.headers.set("Content-Security-Policy", "default-src 'none'");
    }

    // `no-store` unless the handler opted into caching with an explicit
    // lifetime (the public model catalog, private rendered media). Streams set
    // `no-cache`, which carries no lifetime, so they still end up `no-store`.
    if (!isCacheableByHandler(c.res.headers.get("Cache-Control"))) {
        c.res.headers.set("Cache-Control", "no-store");
    }
});

export const corsMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const origin = c.req.header("Origin");
    const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? [];
    const allowed = !!origin && allowedOrigins.length > 0 && allowedOrigins.includes(origin);

    // Preflight: short-circuit BEFORE running the chain so we don't leak any
    // cross-cutting state from downstream handlers.
    if (c.req.method === "OPTIONS") {
        const headers = new Headers();

        if (allowed) {
            headers.set("Access-Control-Allow-Origin", origin);
            headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
            headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Signature, X-Timestamp, X-Provider-Key");
            headers.set("Access-Control-Max-Age", "86400");
            headers.set("Vary", "Origin");
        }

        return new Response(null, { headers, status: 204 });
    }

    await next();

    // Apply CORS headers AFTER the downstream handler runs. Setting them before
    // `next()` is unsafe because handlers may replace `c.res` entirely (e.g.
    // streaming responses, raw `Response` returns), which discards the headers.
    if (allowed) {
        c.res.headers.set("Access-Control-Allow-Origin", origin);
        c.res.headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        c.res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Signature, X-Timestamp, X-Provider-Key");
        c.res.headers.set("Vary", "Origin");
    }

    return undefined;
});

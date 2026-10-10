import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../index.js";

export const securityMiddleware = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
    const requestId = crypto.randomUUID();

    c.set("requestId" as never, requestId);

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

    c.res.headers.set("Cache-Control", "no-store");
});

export const corsMiddleware = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
    // This service is internal-only (backend → Worker). Browser CORS is not supported.
    if (c.req.method === "OPTIONS") {
        return new Response(null, { status: 405 });
    }

    return next();
});

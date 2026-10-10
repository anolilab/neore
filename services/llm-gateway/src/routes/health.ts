import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../env.js";

const healthRouter = new OpenAPIHono<HonoEnv>();

/** One dependency probe in the full health report. */
type DependencyCheck = {
    error?: string;
    healthy: boolean;
};

type HealthReport = {
    d1?: DependencyCheck;
    kv?: DependencyCheck;
    service: string;
    status: string;
    timestamp: string;
    version: string;
};

healthRouter.openapi(
    {
        method: "get",
        path: "/health",
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Service health report",
            },
            503: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Service unhealthy",
            },
        },
        summary: "Full health report",
        tags: ["Health"],
    },
    async (c) => {
        const checks: HealthReport = {
            service: "llm-gateway",
            status: "ok",
            timestamp: new Date().toISOString(),
            version: c.env.APP_VERSION,
        };

        // Check D1 connectivity
        try {
            await c.env.USAGE_DB.prepare("SELECT 1").run();
            checks["d1"] = { healthy: true };
        } catch (error) {
            checks["d1"] = { error: error instanceof Error ? error.message : "Unknown", healthy: false };
        }

        // Check KV connectivity
        try {
            await c.env.RATE_LIMIT_KV.get("__health_check__");
            checks["kv"] = { healthy: true };
        } catch (error) {
            checks["kv"] = { error: error instanceof Error ? error.message : "Unknown", healthy: false };
        }

        const isHealthy = checks["d1"]?.["healthy"] !== false;

        return c.json(checks, isHealthy ? 200 : 503);
    },
);

healthRouter.openapi(
    {
        method: "get",
        path: "/health/live",
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ status: z.string() }) } },
                description: "Service is live",
            },
        },
        summary: "Liveness check",
        tags: ["Health"],
    },
    async (c) => c.json({ status: "live" }, 200),
);

export { healthRouter };

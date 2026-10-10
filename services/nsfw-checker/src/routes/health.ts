import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { AppEnv } from "../index.js";
import { health } from "../lib/health-check.js";

const healthRouter = new OpenAPIHono<{ Bindings: AppEnv }>();

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
        const report = await health.getReport();
        const status = report.healthy ? 200 : 503;

        return c.json(report, status);
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
            503: {
                content: { "application/json": { schema: z.object({ status: z.string() }) } },
                description: "Service is not live",
            },
        },
        summary: "Liveness check",
        tags: ["Health"],
    },
    async (c) => {
        const live = await health.isLive();

        if (live) {
            return c.json({ status: "live" }, 200);
        }

        return c.json({ status: "not live" }, 503);
    },
);

export { healthRouter };

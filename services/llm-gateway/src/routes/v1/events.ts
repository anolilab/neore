/**
 * GET /v1/events — SSE stream for live dashboard updates.
 *
 * Pushes real-time usage, health, and notification events to the
 * frontend usage dashboard. Uses Hono's built-in SSE streaming helper.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";
import { ProviderHealthService } from "../../providers/health.js";
import { UsageAggregator } from "../../usage/aggregator.js";

const eventsRouter = new OpenAPIHono<HonoEnv>();

/** Interval between usage polls (ms) */
const USAGE_POLL_INTERVAL = 10_000;
/** Interval between health polls (ms) */
const HEALTH_POLL_INTERVAL = 30_000;
/** Max connection duration (ms) — client reconnects after this */
const MAX_CONNECTION_DURATION = 300_000;

eventsRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/v1/events",
        request: {
            query: z.object({
                types: z.string().optional(),
                userId: z.string(),
            }),
        },
        responses: {
            200: {
                content: { "text/event-stream": { schema: z.string() } },
                description: "SSE event stream",
            },
        },
        summary: "Live dashboard event stream",
        tags: ["Usage"],
    },
    (c) => {
        const { types, userId } = c.req.valid("query");
        const typeFilter = types ? new Set(types.split(",")) : null;

        const shouldEmit = (type: string) => !typeFilter || typeFilter.has(type);

        return streamSSE(c, async (stream) => {
            // Send initial connected event
            await stream.writeSSE({
                data: JSON.stringify({ timestamp: new Date().toISOString() }),
                event: "connected",
            });

            const aggregator = new UsageAggregator(c.env);
            const healthService = new ProviderHealthService(c.env);

            let lastUsageCheck = Date.now();
            const startTime = Date.now();

            // Poll loop — runs until max duration or client disconnect
            while (Date.now() - startTime < MAX_CONNECTION_DURATION) {
                const now = Date.now();

                // Usage update
                if (shouldEmit("usage") && now - lastUsageCheck >= USAGE_POLL_INTERVAL) {
                    try {
                        const summary = await aggregator.getUserUsage(userId, 1);

                        await stream.writeSSE({
                            data: JSON.stringify({
                                byModel: summary.byModel,
                                timestamp: new Date().toISOString(),
                                totalCostMicrodollars: summary.totalCostMicrodollars,
                                totalRequests: summary.totalRequests,
                                totalTokens: summary.totalPromptTokens + summary.totalCompletionTokens,
                                type: "usage-update",
                            }),
                            event: "usage-update",
                        });
                        lastUsageCheck = now;
                    } catch {
                        // Non-fatal — skip this poll cycle
                    }
                }

                // Health update (less frequent)
                if (shouldEmit("health") && now % HEALTH_POLL_INTERVAL < USAGE_POLL_INTERVAL) {
                    try {
                        const statuses = await healthService.getAllStatuses();

                        await stream.writeSSE({
                            data: JSON.stringify({
                                providers: statuses.map((s) => {
                                    return {
                                        avgLatencyMs: s.avgLatency5mMs,
                                        errorRate: s.errorRate5m,
                                        model: s.modelApiId,
                                        provider: s.provider,
                                        status: s.status,
                                    };
                                }),
                                timestamp: new Date().toISOString(),
                                type: "health-update",
                            }),
                            event: "health-update",
                        });
                    } catch {
                        // Non-fatal
                    }
                }

                // Heartbeat
                if (shouldEmit("heartbeat")) {
                    await stream.writeSSE({
                        data: JSON.stringify({ timestamp: new Date().toISOString(), type: "heartbeat" }),
                        event: "heartbeat",
                    });
                }

                // Sleep until next poll
                await stream.sleep(USAGE_POLL_INTERVAL);
            }
        });
    },
);

export { eventsRouter };

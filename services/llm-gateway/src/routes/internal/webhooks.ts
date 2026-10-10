/**
 * Webhook management endpoints (HMAC auth).
 *
 * POST   /internal/webhooks           — register a webhook
 * GET    /internal/webhooks?userId=X  — list webhooks for a user
 * DELETE /internal/webhooks/:id       — remove a webhook
 * POST   /internal/webhooks/:id/test  — send a test event immediately
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { buildEvent, deliverEvent, validateWebhookUrl } from "../../lib/webhook-delivery.js";
import { internalAuth } from "../../middleware/auth.js";

const webhooksRouter = new OpenAPIHono<HonoEnv>();

/** The columns the list query projects from `webhooks` (secret excluded). */
interface WebhookRow {
    created_at: number;
    events: string;
    id: string;
    is_active: number;
    last_delivery_at: number | null;
    last_delivery_status: number | null;
    org_id: string | null;
    url: string;
    user_id: string;
}

const EVENT_TYPES = ["completion", "budget_exceeded", "guardrail_triggered", "provider_error"] as const;

/**
 * Generate a 256-bit (32-byte) hex-encoded webhook signing secret.
 * Higher entropy than `crypto.randomUUID()` (122 bits) — webhook secrets
 * are used for HMAC signatures and need to resist offline brute force.
 */
const generateWebhookSecret = (): string => {
    const bytes = new Uint8Array(32);

    crypto.getRandomValues(bytes);

    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const webhookSchema = z.object({
    createdAt: z.number(),
    events: z.array(z.string()),
    id: z.string(),
    isActive: z.boolean(),
    lastDeliveryAt: z.number().nullable(),
    lastDeliveryStatus: z.number().nullable(),
    orgId: z.string().nullable(),
    url: z.string(),
    userId: z.string(),
});

// POST /internal/webhooks
webhooksRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/webhooks",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            events: z.array(z.enum(EVENT_TYPES)).min(1),
                            orgId: z.string().optional(),
                            secret: z.string().optional(),
                            url: z.url(),
                            userId: z.string(),
                        }),
                    },
                },
            },
        },
        responses: {
            201: {
                content: { "application/json": { schema: z.object({ id: z.string(), secret: z.string() }) } },
                description: "Webhook registered",
            },
            // The handler rejects a bad callback URL; it was never declared.
            400: {
                content: { "application/json": { schema: z.object({ error: z.string() }) } },
                description: "Invalid webhook URL",
            },
        },
        summary: "Register a webhook endpoint",
        tags: ["Webhooks"],
    },
    async (c) => {
        const body = c.req.valid("json");

        const urlError = validateWebhookUrl(body.url);

        if (urlError) {
            return c.json({ error: urlError }, 400);
        }

        const id = crypto.randomUUID();
        const secret = body.secret ?? generateWebhookSecret();
        const now = Date.now();

        await c.env.USAGE_DB.prepare(
            `INSERT INTO webhooks (id, user_id, org_id, url, secret, events, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
            .bind(id, body.userId, body.orgId ?? null, body.url, secret, JSON.stringify(body.events), now)
            .run();

        return c.json({ id, secret }, 201);
    },
);

// GET /internal/webhooks?userId=X
webhooksRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/webhooks",
        request: {
            query: z.object({ userId: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ webhooks: z.array(webhookSchema) }) } },
                description: "List of webhooks",
            },
        },
        summary: "List webhooks for a user",
        tags: ["Webhooks"],
    },
    async (c) => {
        const { userId } = c.req.valid("query");

        const rows = await c.env.USAGE_DB.prepare(
            "SELECT id, user_id, org_id, url, events, is_active, created_at, last_delivery_at, last_delivery_status FROM webhooks WHERE user_id = ? ORDER BY created_at DESC",
        )
            .bind(userId)
            .all<WebhookRow>();

        const webhooks = (rows.results ?? []).map((row) => {
            return {
                createdAt: row["created_at"],
                events: JSON.parse(row["events"]) as string[],
                id: row["id"],
                isActive: row["is_active"] === 1,
                lastDeliveryAt: row["last_delivery_at"] ?? null,
                lastDeliveryStatus: row["last_delivery_status"] ?? null,
                orgId: row["org_id"] ?? null,
                url: row["url"],
                userId: row["user_id"],
            };
        });

        return c.json({ webhooks }, 200);
    },
);

// DELETE /internal/webhooks/:id
webhooksRouter.openapi(
    {
        method: "delete",
        middleware: [internalAuth] as const,
        path: "/internal/webhooks/:id",
        request: {
            params: z.object({ id: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
                description: "Webhook deleted",
            },
        },
        summary: "Remove a webhook",
        tags: ["Webhooks"],
    },
    async (c) => {
        const { id } = c.req.valid("param");

        const result = await c.env.USAGE_DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(id).run();

        return c.json({ deleted: (result.meta?.changes ?? 0) > 0 }, 200);
    },
);

// POST /internal/webhooks/:id/test
webhooksRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/webhooks/:id/test",
        request: {
            params: z.object({ id: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ delivered: z.boolean(), deliveryId: z.string() }) } },
                description: "Test event sent",
            },
            404: {
                content: { "application/json": { schema: z.object({ error: z.string() }) } },
                description: "Webhook not found",
            },
        },
        summary: "Send a test event to a webhook",
        tags: ["Webhooks"],
    },
    async (c) => {
        const { id } = c.req.valid("param");

        const row = await c.env.USAGE_DB.prepare("SELECT id, user_id, url, secret, events FROM webhooks WHERE id = ?")
            .bind(id)
            .first<{ events: string; id: string; secret: string; url: string; user_id: string }>();

        if (!row) {
            return c.json({ error: "Webhook not found" }, 404);
        }

        const testEvent = buildEvent("completion", row.user_id, {
            completionTokens: 5,
            costMicrodollars: 100,
            latencyMs: 250,
            modelId: "gpt-4o",
            promptTokens: 10,
            test: true,
        });

        c.executionCtx.waitUntil(deliverEvent(c.env.USAGE_DB, testEvent));

        return c.json({ delivered: true, deliveryId: testEvent.id }, 200);
    },
);

export { webhooksRouter };

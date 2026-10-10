/**
 * CRUD endpoints for user notification rules (cost/usage threshold alerts).
 *
 * GET  /internal/notification-rules?userId=...         — list rules for a user
 * POST /internal/notification-rules                    — create a rule
 * DELETE /internal/notification-rules/:ruleId          — delete a rule (must match userId)
 *
 * All endpoints use HMAC authentication.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";

const notificationRulesRouter = new OpenAPIHono<HonoEnv>();

/** The `notification_rules` table, as `SELECT *` returns it. */
interface NotificationRuleRow {
    action: string;
    created_at: string;
    id: string;
    is_active: number;
    last_triggered_at: string | null;
    metric: string;
    model_filter: string | null;
    name: string;
    org_id: string | null;
    period: string;
    threshold: number;
    user_id: string;
}

const ruleSchema = z.object({
    action: z.enum(["notify", "block", "notify_and_block"]),
    createdAt: z.string(),
    id: z.string(),
    isActive: z.boolean(),
    lastTriggeredAt: z.string().nullable(),
    metric: z.enum(["daily_cost", "monthly_cost", "request_count", "token_count"]),
    modelFilter: z.string().nullable(),
    name: z.string(),
    orgId: z.string().nullable(),
    period: z.enum(["hour", "day", "month"]),
    threshold: z.number(),
    userId: z.string(),
});

// ── List rules ─────────────────────────────────────────────────────────────

notificationRulesRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/notification-rules",
        request: {
            query: z.object({
                userId: z.string(),
            }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ rules: z.array(ruleSchema) }) } },
                description: "List of notification rules",
            },
        },
        summary: "List notification rules for a user",
        tags: ["Internal"],
    },
    async (c) => {
        const { userId } = c.req.valid("query");
        const database = c.env.USAGE_DB;

        const result = await database
            .prepare("SELECT * FROM notification_rules WHERE user_id = ? ORDER BY created_at DESC")
            .bind(userId)
            .all<NotificationRuleRow>();

        const rules = (result.results ?? []).map((row) => {
            return {
                action: String(row["action"] ?? "notify") as z.infer<typeof ruleSchema>["action"],
                createdAt: String(row["created_at"] ?? ""),
                id: String(row["id"] ?? ""),
                isActive: Boolean(row["is_active"]),
                lastTriggeredAt: row["last_triggered_at"] ? String(row["last_triggered_at"]) : null,
                metric: String(row["metric"] ?? "daily_cost") as z.infer<typeof ruleSchema>["metric"],
                modelFilter: row["model_filter"] ? String(row["model_filter"]) : null,
                name: String(row["name"] ?? ""),
                orgId: row["org_id"] ? String(row["org_id"]) : null,
                period: String(row["period"] ?? "day") as z.infer<typeof ruleSchema>["period"],
                threshold: Number(row["threshold"] ?? 0),
                userId: String(row["user_id"] ?? ""),
            };
        });

        return c.json({ rules }, 200);
    },
);

// ── Create rule ─────────────────────────────────────────────────────────────

const createRuleBodySchema = z.object({
    action: z.enum(["notify", "block", "notify_and_block"]).default("notify"),
    metric: z.enum(["daily_cost", "monthly_cost", "request_count", "token_count"]),
    modelFilter: z.string().optional(),
    name: z.string().min(1).max(80),
    orgId: z.string().optional(),
    period: z.enum(["hour", "day", "month"]).default("day"),
    threshold: z.number().min(1),
    userId: z.string(),
});

notificationRulesRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/notification-rules",
        request: {
            body: {
                content: { "application/json": { schema: createRuleBodySchema } },
            },
        },
        responses: {
            200: {
                content: { "application/json": { schema: ruleSchema } },
                description: "Created rule",
            },
        },
        summary: "Create a notification rule",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const database = c.env.USAGE_DB;
        const id = crypto.randomUUID();

        await database
            .prepare(
                `INSERT INTO notification_rules (id, user_id, org_id, name, metric, threshold, period, model_filter, action, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            )
            .bind(id, body.userId, body.orgId ?? null, body.name, body.metric, body.threshold, body.period, body.modelFilter ?? null, body.action)
            .run();

        const row = await database.prepare("SELECT * FROM notification_rules WHERE id = ?").bind(id).first<NotificationRuleRow>();

        if (!row) {
            return c.json({ error: "Failed to create rule" } as unknown as z.infer<typeof ruleSchema>, 500 as unknown as 200);
        }

        return c.json(
            {
                action: String(row["action"] ?? "notify") as z.infer<typeof ruleSchema>["action"],
                createdAt: String(row["created_at"] ?? ""),
                id: String(row["id"] ?? ""),
                isActive: Boolean(row["is_active"]),
                lastTriggeredAt: row["last_triggered_at"] ? String(row["last_triggered_at"]) : null,
                metric: String(row["metric"] ?? "daily_cost") as z.infer<typeof ruleSchema>["metric"],
                modelFilter: row["model_filter"] ? String(row["model_filter"]) : null,
                name: String(row["name"] ?? ""),
                orgId: row["org_id"] ? String(row["org_id"]) : null,
                period: String(row["period"] ?? "day") as z.infer<typeof ruleSchema>["period"],
                threshold: Number(row["threshold"] ?? 0),
                userId: String(row["user_id"] ?? ""),
            },
            200,
        );
    },
);

// ── Delete rule ─────────────────────────────────────────────────────────────

notificationRulesRouter.openapi(
    {
        method: "delete",
        middleware: [internalAuth] as const,
        path: "/internal/notification-rules/:ruleId",
        request: {
            params: z.object({ ruleId: z.string() }),
            query: z.object({ userId: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
                description: "Success",
            },
        },
        summary: "Delete a notification rule",
        tags: ["Internal"],
    },
    async (c) => {
        const { ruleId } = c.req.valid("param");
        const { userId } = c.req.valid("query");
        const database = c.env.USAGE_DB;

        // Ensure the rule belongs to this user before deleting
        await database.prepare("DELETE FROM notification_rules WHERE id = ? AND user_id = ?").bind(ruleId, userId).run();

        return c.json({ ok: true }, 200);
    },
);

export { notificationRulesRouter };

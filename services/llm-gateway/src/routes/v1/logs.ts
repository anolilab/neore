/**
 * GET /v1/logs — Queryable request history.
 *
 * Returns paginated usage log entries from D1 `usage_log`.
 *
 * Auth rules:
 *  - Bearer token (gk_*): users see ONLY their own logs (userId enforced)
 *  - HMAC: admin access — can filter by any userId or see all logs
 *
 * Query params:
 *  - limit   (default 50, max 200)
 *  - offset  (default 0)
 *  - model   — filter by model_id
 *  - provider— filter by provider
 *  - userId  — HMAC only; filter by user
 *  - from    — ISO date string, lower bound for created_at
 *  - to      — ISO date string, upper bound for created_at
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { bearerAuth, internalAuth } from "../../middleware/auth.js";

const logsRouter = new OpenAPIHono<HonoEnv>();

const MAX_LIMIT = 200;

const logEntrySchema = z.object({
    cachedTokens: z.number(),
    completionTokens: z.number(),
    costMicrodollars: z.number(),
    createdAt: z.string(),
    errorCode: z.string().nullable(),
    finishReason: z.string().nullable(),
    id: z.string(),
    isStreaming: z.boolean(),
    latencyMs: z.number(),
    modelApiId: z.string(),
    modelId: z.string(),
    orgId: z.string().nullable(),
    promptTokens: z.number(),
    provider: z.string(),
    reasoningTokens: z.number(),
    requestId: z.string(),
    routedModelId: z.string().nullable(),
    routingConfidence: z.number().nullable(),
    routingTier: z.string().nullable(),
    source: z.string(),
    threadId: z.string().nullable(),
    ttftMs: z.number().nullable(),
    userId: z.string(),
});

const logsResponseSchema = z.object({
    data: z.array(logEntrySchema),
    pagination: z.object({
        hasMore: z.boolean(),
        limit: z.number(),
        offset: z.number(),
        total: z.number(),
    }),
});

// ── Shared query builder ─────────────────────────────────────────────────────

function buildLogsQuery(params: { from?: string; limit: number; model?: string; offset: number; provider?: string; to?: string; userId?: string }): {
    bindings: unknown[];
    countSql: string;
    sql: string;
} {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (params.userId) {
        conditions.push("user_id = ?");
        bindings.push(params.userId);
    }

    if (params.model) {
        conditions.push("model_id = ?");
        bindings.push(params.model);
    }

    if (params.provider) {
        conditions.push("provider = ?");
        bindings.push(params.provider);
    }

    if (params.from) {
        conditions.push("created_at >= ?");
        bindings.push(params.from);
    }

    if (params.to) {
        conditions.push("created_at <= ?");
        bindings.push(params.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
        SELECT
            id, request_id, user_id, org_id, thread_id,
            model_id, provider, model_api_id, routed_model_id,
            routing_tier, routing_confidence,
            prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
            cost_microdollars, latency_ms, ttft_ms,
            is_streaming, finish_reason, error_code, source, created_at
        FROM usage_log
        ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `;

    const countSql = `SELECT COUNT(*) as total FROM usage_log ${where}`;

    return { bindings, countSql, sql };
}

/** The columns `buildLogsQuery` projects from `usage_log`. */
interface UsageLogRow {
    cached_tokens: number;
    completion_tokens: number;
    cost_microdollars: number;
    created_at: string;
    error_code: string | null;
    finish_reason: string | null;
    id: string;
    is_streaming: number;
    latency_ms: number;
    model_api_id: string;
    model_id: string;
    org_id: string | null;
    prompt_tokens: number;
    provider: string;
    reasoning_tokens: number;
    request_id: string;
    routed_model_id: string | null;
    routing_confidence: number | null;
    routing_tier: string | null;
    source: string;
    thread_id: string | null;
    ttft_ms: number | null;
    user_id: string;
}

function mapRow(row: UsageLogRow) {
    return {
        cachedTokens: Number(row["cached_tokens"] ?? 0),
        completionTokens: Number(row["completion_tokens"] ?? 0),
        costMicrodollars: Number(row["cost_microdollars"] ?? 0),
        createdAt: String(row["created_at"] ?? ""),
        errorCode: row["error_code"] ? String(row["error_code"]) : null,
        finishReason: row["finish_reason"] ? String(row["finish_reason"]) : null,
        id: String(row["id"] ?? ""),
        isStreaming: Boolean(row["is_streaming"]),
        latencyMs: Number(row["latency_ms"] ?? 0),
        modelApiId: String(row["model_api_id"] ?? ""),
        modelId: String(row["model_id"] ?? ""),
        orgId: row["org_id"] ? String(row["org_id"]) : null,
        promptTokens: Number(row["prompt_tokens"] ?? 0),
        provider: String(row["provider"] ?? ""),
        reasoningTokens: Number(row["reasoning_tokens"] ?? 0),
        requestId: String(row["request_id"] ?? ""),
        routedModelId: row["routed_model_id"] ? String(row["routed_model_id"]) : null,
        routingConfidence: row["routing_confidence"] == null ? null : Number(row["routing_confidence"]),
        routingTier: row["routing_tier"] ? String(row["routing_tier"]) : null,
        source: String(row["source"] ?? "internal"),
        threadId: row["thread_id"] ? String(row["thread_id"]) : null,
        ttftMs: row["ttft_ms"] == null ? null : Number(row["ttft_ms"]),
        userId: String(row["user_id"] ?? ""),
    };
}

// ── SaaS API route (Bearer auth — own logs only) ─────────────────────────────

const bearerQuerySchema = z.object({
    from: z.string().optional(),
    limit: z
        .string()
        .optional()
        .default("50")
        .transform((v) => Math.min(Math.trunc(Number(v)) || 50, MAX_LIMIT)),
    model: z.string().optional(),
    offset: z
        .string()
        .optional()
        .default("0")
        .transform((v) => Math.trunc(Number(v)) || 0),
    provider: z.string().optional(),
    to: z.string().optional(),
});

logsRouter.openapi(
    {
        method: "get",
        middleware: [bearerAuth] as const,
        path: "/v1/logs",
        request: { query: bearerQuerySchema },
        responses: {
            200: {
                content: { "application/json": { schema: logsResponseSchema } },
                description: "Paginated request log entries",
            },
        },
        summary: "Get request log history (own logs)",
        tags: ["Logs"],
    },
    async (c) => {
        const userId = c.get("userId");
        const { from, limit, model, offset, provider, to } = c.req.valid("query");
        const database = c.env.USAGE_DB;

        const { bindings, countSql, sql } = buildLogsQuery({ from, limit, model, offset, provider, to, userId });

        const [countResult, rowsResult] = await Promise.all([
            database
                .prepare(countSql)
                .bind(...bindings)
                .first<{ total: number }>(),
            database
                .prepare(sql)
                .bind(...bindings, limit, offset)
                .all<UsageLogRow>(),
        ]);

        const total = countResult?.total ?? 0;
        const data = (rowsResult.results ?? []).map((row) => mapRow(row));

        return c.json(
            {
                data,
                pagination: {
                    hasMore: offset + data.length < total,
                    limit,
                    offset,
                    total,
                },
            },
            200,
        );
    },
);

// ── Internal admin route (HMAC auth — see all logs) ──────────────────────────

const adminQuerySchema = z.object({
    from: z.string().optional(),
    limit: z
        .string()
        .optional()
        .default("50")
        .transform((v) => Math.min(Math.trunc(Number(v)) || 50, MAX_LIMIT)),
    model: z.string().optional(),
    offset: z
        .string()
        .optional()
        .default("0")
        .transform((v) => Math.trunc(Number(v)) || 0),
    provider: z.string().optional(),
    to: z.string().optional(),
    userId: z.string().optional(),
});

logsRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/admin/logs",
        request: { query: adminQuerySchema },
        responses: {
            200: {
                content: { "application/json": { schema: logsResponseSchema } },
                description: "Paginated request log entries",
            },
        },
        summary: "Get request log history (admin — all users)",
        tags: ["Internal"],
    },
    async (c) => {
        const { from, limit, model, offset, provider, to, userId } = c.req.valid("query");
        const database = c.env.USAGE_DB;

        const { bindings, countSql, sql } = buildLogsQuery({ from, limit, model, offset, provider, to, userId });

        const [countResult, rowsResult] = await Promise.all([
            database
                .prepare(countSql)
                .bind(...bindings)
                .first<{ total: number }>(),
            database
                .prepare(sql)
                .bind(...bindings, limit, offset)
                .all<UsageLogRow>(),
        ]);

        const total = countResult?.total ?? 0;
        const data = (rowsResult.results ?? []).map((row) => mapRow(row));

        return c.json(
            {
                data,
                pagination: {
                    hasMore: offset + data.length < total,
                    limit,
                    offset,
                    total,
                },
            },
            200,
        );
    },
);

export { logsRouter };

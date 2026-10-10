/**
 * GET /metrics — Prometheus text format scrape endpoint.
 *
 * Exposes LLM gateway operational metrics in the Prometheus exposition format
 * so any compatible scraper (Grafana, Victoria Metrics, etc.) can ingest them.
 *
 * Metrics derived from:
 *  - D1 `usage_log`      — recent request data (last 24h)
 *  - D1 `usage_daily`    — materialized historical aggregates
 *  - D1 `provider_health`— circuit-breaker state
 *
 * Auth: HMAC-SHA256 (internal only — prevents leaking cost/usage data).
 */
import { Hono } from "hono";

import type { HonoEnv } from "../env.js";
import { internalAuth } from "../middleware/auth.js";

const metricsRouter = new Hono<HonoEnv>();

/**
 * Row shapes for the aggregation queries below. Each one names exactly the
 * columns its `SELECT` projects, so a query and its reader cannot drift apart
 * silently.
 */
interface ModelRow {
    avg_latency: number;
    completion_tokens: number;
    cost: number;
    model_id: string;
    prompt_tokens: number;
    provider: string;
    requests: number;
}

interface TierRow {
    count: number;
    tier: string | null;
}

interface ProviderHealthRow {
    avg_latency_5m_ms: number;

    /**
     * Not projected by the query below, so it is always `undefined` and the
     * `llm_gateway_circuit_breaker_open` gauge always reports 0. Declared
     * because the reader still consults it.
     */
    circuit_breaker_until?: string | null;
    error_rate_5m: number;
    model_api_id: string;
    provider: string;
    status: string;
}

interface ErrorRow {
    count: number;
    error_code: string | null;
}

interface DailyRow {
    cost: number;
    date: string;
    requests: number;
}

// ── Prometheus text format helpers ──────────────────────────────────────────

const help = (name: string, description: string) => `# HELP ${name} ${description}`;
const type = (name: string, metricType: string) => `# TYPE ${name} ${metricType}`;
const sample = (name: string, labels: Record<string, string>, value: number) => {
    const labelString =
        Object.keys(labels).length > 0
            ? `{${Object.entries(labels)
                  .map(
                      ([k, v]) =>
                          `${k}="${v
                              .replaceAll("\\", "\\\\")
                              .replaceAll('"', String.raw`\"`)
                              .replaceAll("\n", String.raw`\n`)}"`,
                  )
                  .join(",")}}`
            : "";

    return `${name}${labelString} ${Number.isFinite(value) ? value : 0}`;
};

// ── Endpoint ──────────────────────────────────────────────────────────────

metricsRouter.get("/metrics", internalAuth, async (c) => {
    const database = c.env.USAGE_DB;
    const now = Date.now();

    // Run all aggregation queries in parallel
    const [recentRows, modelRows, tierRows, providerRows, errorRows, cacheRows, dailyRows] = await Promise.all([
        // Overview stats for the last 24h
        database
            .prepare(
                `SELECT
                    COUNT(*) as total_requests,
                    COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
                    COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
                    COALESCE(SUM(cost_microdollars), 0) as total_cost,
                    COALESCE(AVG(latency_ms), 0) as avg_latency,
                    COALESCE(MIN(latency_ms), 0) as min_latency,
                    COALESCE(MAX(latency_ms), 0) as max_latency,
                    COALESCE(AVG(ttft_ms), 0) as avg_ttft
                 FROM usage_log
                 WHERE created_at >= datetime('now', '-1 day')`,
            )
            .first<Record<string, number>>(),

        // Per-model/provider request counts + costs (last 24h)
        database
            .prepare(
                `SELECT
                    model_id, provider,
                    COUNT(*) as requests,
                    COALESCE(SUM(cost_microdollars), 0) as cost,
                    COALESCE(AVG(latency_ms), 0) as avg_latency,
                    COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) as completion_tokens
                 FROM usage_log
                 WHERE created_at >= datetime('now', '-1 day')
                 GROUP BY model_id, provider`,
            )
            .all<ModelRow>(),

        // Routing tier distribution (last 24h)
        database
            .prepare(
                `SELECT routing_tier as tier, COUNT(*) as count
                 FROM usage_log
                 WHERE routing_tier IS NOT NULL AND created_at >= datetime('now', '-1 day')
                 GROUP BY routing_tier`,
            )
            .all<TierRow>(),

        // Provider health / circuit breaker state
        database
            .prepare(
                // `circuit_breaker_until` is read below to emit
                // `llm_gateway_circuit_breaker_open`. It was missing from this
                // projection, so the gauge reported 0 unconditionally — the
                // metric that says "a provider is being circuit-broken" could
                // never fire. The column exists on the table and is written by
                // the health checker and the reset sweep in `index.ts`.
                `SELECT provider, model_api_id, status, error_rate_5m, avg_latency_5m_ms, circuit_breaker_until
                 FROM provider_health`,
            )
            .all<ProviderHealthRow>(),

        // Error counts by error_code (last 24h)
        database
            .prepare(
                `SELECT error_code, COUNT(*) as count
                 FROM usage_log
                 WHERE error_code IS NOT NULL AND created_at >= datetime('now', '-1 day')
                 GROUP BY error_code`,
            )
            .all<ErrorRow>(),

        // Cache hit/miss aggregate (last 24h)
        database
            .prepare(
                `SELECT
                    COALESCE(SUM(CASE WHEN cached_tokens > 0 THEN 1 ELSE 0 END), 0) as cache_hits,
                    COALESCE(SUM(CASE WHEN cached_tokens = 0 THEN 1 ELSE 0 END), 0) as cache_misses
                 FROM usage_log
                 WHERE created_at >= datetime('now', '-1 day')`,
            )
            .first<Record<string, number>>(),

        // Historical daily totals (last 30 days from materialized table)
        database
            .prepare(
                `SELECT
                    date,
                    COALESCE(SUM(request_count), 0) as requests,
                    COALESCE(SUM(total_cost_microdollars), 0) as cost
                 FROM usage_daily
                 WHERE date >= date('now', '-30 days')
                 GROUP BY date
                 ORDER BY date DESC
                 LIMIT 30`,
            )
            .all<DailyRow>(),
    ]);

    const modelResults = modelRows.results ?? [];
    const dailyResults = dailyRows.results ?? [];

    const lines: string[] = [
        `# LLM Gateway metrics — generated at ${new Date(now).toISOString()}`,
        "",

        // ── llm_gateway_requests_total ───────────────────────────────────────
        help("llm_gateway_requests_total", "Total number of LLM API requests in the last 24h"),
        type("llm_gateway_requests_total", "gauge"),
        sample("llm_gateway_requests_total", {}, Number(recentRows?.["total_requests"] ?? 0)),
        "",

        // ── llm_gateway_requests_by_model ───────────────────────────────────
        help("llm_gateway_requests_by_model", "Request count per model/provider in the last 24h"),
        type("llm_gateway_requests_by_model", "gauge"),
        ...modelResults.map((row) =>
            sample(
                "llm_gateway_requests_by_model",
                { model: String(row["model_id"] ?? ""), provider: String(row["provider"] ?? "") },
                Number(row["requests"] ?? 0),
            ),
        ),
        "",

        // ── llm_gateway_cost_microdollars_total ──────────────────────────────
        help("llm_gateway_cost_microdollars_total", "Total cost in microdollars in the last 24h"),
        type("llm_gateway_cost_microdollars_total", "gauge"),
        sample("llm_gateway_cost_microdollars_total", {}, Number(recentRows?.["total_cost"] ?? 0)),
        "",

        // ── llm_gateway_cost_by_model ─────────────────────────────────────
        help("llm_gateway_cost_by_model", "Cost in microdollars per model/provider in the last 24h"),
        type("llm_gateway_cost_by_model", "gauge"),
        ...modelResults.map((row) =>
            sample("llm_gateway_cost_by_model", { model: String(row["model_id"] ?? ""), provider: String(row["provider"] ?? "") }, Number(row["cost"] ?? 0)),
        ),
        "",

        // ── llm_gateway_tokens_total ──────────────────────────────────────
        help("llm_gateway_tokens_total", "Total tokens processed in the last 24h by type"),
        type("llm_gateway_tokens_total", "gauge"),
        sample("llm_gateway_tokens_total", { type: "prompt" }, Number(recentRows?.["total_prompt_tokens"] ?? 0)),
        sample("llm_gateway_tokens_total", { type: "completion" }, Number(recentRows?.["total_completion_tokens"] ?? 0)),
        sample("llm_gateway_tokens_total", { type: "cached" }, Number(recentRows?.["total_cached_tokens"] ?? 0)),
        "",

        // ── llm_gateway_tokens_by_model ─────────────────────────────────
        help("llm_gateway_tokens_by_model", "Tokens per model/provider in the last 24h by type"),
        type("llm_gateway_tokens_by_model", "gauge"),
        ...modelResults.flatMap((row) => {
            const labels = { model: String(row["model_id"] ?? ""), provider: String(row["provider"] ?? "") };

            return [
                sample("llm_gateway_tokens_by_model", { ...labels, type: "prompt" }, Number(row["prompt_tokens"] ?? 0)),
                sample("llm_gateway_tokens_by_model", { ...labels, type: "completion" }, Number(row["completion_tokens"] ?? 0)),
            ];
        }),
        "",

        // ── llm_gateway_latency_ms ────────────────────────────────────────
        help("llm_gateway_latency_ms", "Request latency in milliseconds (avg/min/max) in the last 24h"),
        type("llm_gateway_latency_ms", "gauge"),
        sample("llm_gateway_latency_ms", { quantile: "avg" }, Math.round(Number(recentRows?.["avg_latency"] ?? 0))),
        sample("llm_gateway_latency_ms", { quantile: "min" }, Number(recentRows?.["min_latency"] ?? 0)),
        sample("llm_gateway_latency_ms", { quantile: "max" }, Number(recentRows?.["max_latency"] ?? 0)),
        "",

        // ── llm_gateway_latency_by_model ─────────────────────────────────
        help("llm_gateway_latency_by_model", "Average latency per model/provider in the last 24h"),
        type("llm_gateway_latency_by_model", "gauge"),
        ...modelResults.map((row) =>
            sample(
                "llm_gateway_latency_by_model",
                { model: String(row["model_id"] ?? ""), provider: String(row["provider"] ?? "") },
                Math.round(Number(row["avg_latency"] ?? 0)),
            ),
        ),
        "",

        // ── llm_gateway_ttft_ms ───────────────────────────────────────────
        help("llm_gateway_ttft_ms", "Average time-to-first-token in milliseconds in the last 24h"),
        type("llm_gateway_ttft_ms", "gauge"),
        sample("llm_gateway_ttft_ms", {}, Math.round(Number(recentRows?.["avg_ttft"] ?? 0))),
        "",

        // ── llm_gateway_cache_requests ────────────────────────────────────
        help("llm_gateway_cache_requests", "Cache hit/miss count in the last 24h"),
        type("llm_gateway_cache_requests", "gauge"),
        sample("llm_gateway_cache_requests", { result: "hit" }, Number(cacheRows?.["cache_hits"] ?? 0)),
        sample("llm_gateway_cache_requests", { result: "miss" }, Number(cacheRows?.["cache_misses"] ?? 0)),
        "",

        // ── llm_gateway_routing_tier_requests ────────────────────────────
        help("llm_gateway_routing_tier_requests", "Request count by routing tier in the last 24h"),
        type("llm_gateway_routing_tier_requests", "gauge"),
        ...(tierRows.results ?? []).map((row) =>
            sample("llm_gateway_routing_tier_requests", { tier: String(row["tier"] ?? "unknown") }, Number(row["count"] ?? 0)),
        ),
        "",

        // ── llm_gateway_errors_total ──────────────────────────────────────
        help("llm_gateway_errors_total", "Total error count by error code in the last 24h"),
        type("llm_gateway_errors_total", "gauge"),
        ...(errorRows.results ?? []).map((row) =>
            sample("llm_gateway_errors_total", { code: String(row["error_code"] ?? "unknown") }, Number(row["count"] ?? 0)),
        ),
        "",

        // ── llm_gateway_provider_health ────────────────────────────────────
        help("llm_gateway_provider_health", "Provider health status (1=healthy, 0=degraded/offline)"),
        type("llm_gateway_provider_health", "gauge"),
        help("llm_gateway_provider_error_rate", "Provider 5-minute error rate (0.0–1.0)"),
        type("llm_gateway_provider_error_rate", "gauge"),
        help("llm_gateway_provider_latency_ms", "Provider average latency over last 5 minutes"),
        type("llm_gateway_provider_latency_ms", "gauge"),
        help("llm_gateway_circuit_breaker_open", "1 if the circuit breaker is currently open for this provider/model"),
        type("llm_gateway_circuit_breaker_open", "gauge"),
        ...(providerRows.results ?? []).flatMap((row) => {
            const labels = { model: String(row["model_api_id"] ?? ""), provider: String(row["provider"] ?? "") };
            const healthValue = String(row["status"] ?? "healthy") === "healthy" ? 1 : 0;
            const circuitOpen = row["circuit_breaker_until"] ? 1 : 0;

            return [
                sample("llm_gateway_provider_health", labels, healthValue),
                sample("llm_gateway_provider_error_rate", labels, Number(row["error_rate_5m"] ?? 0)),
                sample("llm_gateway_provider_latency_ms", labels, Number(row["avg_latency_5m_ms"] ?? 0)),
                sample("llm_gateway_circuit_breaker_open", labels, circuitOpen),
            ];
        }),
        "",

        // ── llm_gateway_daily_cost_microdollars ────────────────────────────
        help("llm_gateway_daily_cost_microdollars", "Daily total cost in microdollars (last 30 days from materialized table)"),
        type("llm_gateway_daily_cost_microdollars", "gauge"),
        ...dailyResults.map((row) => sample("llm_gateway_daily_cost_microdollars", { date: String(row["date"] ?? "") }, Number(row["cost"] ?? 0))),
        "",

        // ── llm_gateway_daily_requests ────────────────────────────────────
        help("llm_gateway_daily_requests", "Daily total request count (last 30 days from materialized table)"),
        type("llm_gateway_daily_requests", "gauge"),
        ...dailyResults.map((row) => sample("llm_gateway_daily_requests", { date: String(row["date"] ?? "") }, Number(row["requests"] ?? 0))),
        "",
    ];

    return new Response(lines.join("\n"), {
        headers: {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        },
        status: 200,
    });
});

export { metricsRouter };

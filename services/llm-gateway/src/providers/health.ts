/**
 * Provider health tracking and circuit breaker.
 *
 * Tracks success/failure rates in D1 and opens circuit breaker
 * when error rate exceeds threshold. Hot-path reads are cached
 * in KV (30s TTL) to avoid D1 queries on every request.
 */
import type { AppEnv } from "../env.js";

export interface ProviderHealthStatus {
    avgLatency5mMs: number;
    circuitBreakerUntil: string | null;
    errorRate5m: number;
    modelApiId: string;
    provider: string;
    status: "healthy" | "degraded" | "down";
}

/** The `provider_health` table, as `SELECT *` returns it. */
interface ProviderHealthRow {
    avg_latency_5m_ms: number;
    circuit_breaker_until: string | null;
    error_rate_5m: number;
    last_failure_at: string | null;
    last_success_at: string | null;
    model_api_id: string;
    provider: string;
    status: string;
    updated_at: string;
}

/** Circuit breaker opens for 60 seconds after error threshold */
const CIRCUIT_BREAKER_DURATION_MS = 60_000;
/** Error rate threshold to trip the circuit breaker */
const ERROR_RATE_THRESHOLD = 0.5;
/** KV cache TTL for health status (seconds) */
const HEALTH_CACHE_TTL = 30;

/** Maps the breaker decision and current error rate onto the stored health status. */
const statusForErrorRate = (shouldTrip: boolean, errorRate: number): string => {
    if (shouldTrip) return "down";

    if (errorRate > 0.2) return "degraded";

    return "healthy";
};

export class ProviderHealthService {
    private db: D1Database;

    private kv: KVNamespace;

    constructor(env: AppEnv) {
        this.db = env.USAGE_DB;
        this.kv = env.RATE_LIMIT_KV;
    }

    /**
     * Check if a provider/model is healthy (circuit breaker closed).
     * Uses KV cache to avoid D1 queries on every request.
     */
    async isHealthy(provider: string, modelApiId: string): Promise<boolean> {
        const cacheKey = `health:${provider}:${modelApiId}`;

        try {
            // Check KV cache first (avoids D1 on hot path)
            const cached = await this.kv.get(cacheKey, "json");

            if (cached) {
                const entry = cached as { circuitBreakerUntil: string | null; status: string };

                if (entry.circuitBreakerUntil) {
                    const until = new Date(entry.circuitBreakerUntil).getTime();

                    if (Date.now() < until) {
                        return false;
                    }
                }

                return entry.status !== "down";
            }

            // KV miss — query D1 and populate cache
            const row = await this.db
                .prepare("SELECT status, circuit_breaker_until FROM provider_health WHERE provider = ? AND model_api_id = ?")
                .bind(provider, modelApiId)
                .first<{ circuit_breaker_until: string | null; status: string }>();

            if (!row) {
                // No data = healthy; cache it to avoid repeated D1 misses
                await this.kv.put(cacheKey, JSON.stringify({ circuitBreakerUntil: null, status: "healthy" }), { expirationTtl: HEALTH_CACHE_TTL });

                return true;
            }

            // Cache the D1 result
            await this.kv.put(cacheKey, JSON.stringify({ circuitBreakerUntil: row.circuit_breaker_until, status: row.status }), {
                expirationTtl: HEALTH_CACHE_TTL,
            });

            // Check circuit breaker
            if (row.circuit_breaker_until) {
                const until = new Date(row.circuit_breaker_until).getTime();

                if (Date.now() < until) {
                    return false; // Circuit breaker is open
                }

                // Circuit breaker expired — reset to healthy
                await this.db
                    .prepare(
                        "UPDATE provider_health SET status = 'healthy', circuit_breaker_until = NULL, updated_at = datetime('now') WHERE provider = ? AND model_api_id = ?",
                    )
                    .bind(provider, modelApiId)
                    .run();

                // Invalidate stale "down" cache entry so subsequent reads see "healthy"
                await this.kv.delete(cacheKey);
            }

            return row.status !== "down";
        } catch {
            return true; // DB/KV error — assume healthy, don't block requests
        }
    }

    /**
     * Record a successful request. Invalidates KV cache so isHealthy() picks up changes.
     */
    async recordSuccess(provider: string, modelApiId: string, latencyMs: number): Promise<void> {
        try {
            await this.db
                .prepare(
                    `INSERT INTO provider_health (provider, model_api_id, status, error_rate_5m, avg_latency_5m_ms, last_success_at, updated_at)
                     VALUES (?, ?, 'healthy', 0, ?, datetime('now'), datetime('now'))
                     ON CONFLICT(provider, model_api_id) DO UPDATE SET
                       status = 'healthy',
                       avg_latency_5m_ms = (avg_latency_5m_ms + ?) / 2,
                       last_success_at = datetime('now'),
                       updated_at = datetime('now')`,
                )
                .bind(provider, modelApiId, latencyMs, latencyMs)
                .run();

            // Invalidate KV cache so next isHealthy() reads fresh data
            await this.kv.delete(`health:${provider}:${modelApiId}`);
        } catch {
            // Non-critical — don't fail the request
        }
    }

    /**
     * Record a failed request and potentially open the circuit breaker.
     * Invalidates KV cache so isHealthy() picks up the new status.
     */
    async recordFailure(provider: string, modelApiId: string): Promise<void> {
        try {
            // Get recent error data to decide if we should trip the breaker
            const row = await this.db
                .prepare("SELECT error_rate_5m FROM provider_health WHERE provider = ? AND model_api_id = ?")
                .bind(provider, modelApiId)
                .first<{ error_rate_5m: number }>();

            const currentRate = row?.error_rate_5m ?? 0;
            // Simple exponential moving average for error rate
            const newRate = currentRate * 0.7 + 0.3;
            const shouldTrip = newRate >= ERROR_RATE_THRESHOLD;

            const circuitBreakerUntil = shouldTrip ? new Date(Date.now() + CIRCUIT_BREAKER_DURATION_MS).toISOString() : null;

            const status = statusForErrorRate(shouldTrip, newRate);

            await this.db
                .prepare(
                    `INSERT INTO provider_health (provider, model_api_id, status, error_rate_5m, last_failure_at, circuit_breaker_until, updated_at)
                     VALUES (?, ?, ?, ?, datetime('now'), ?, datetime('now'))
                     ON CONFLICT(provider, model_api_id) DO UPDATE SET
                       status = ?,
                       error_rate_5m = ?,
                       last_failure_at = datetime('now'),
                       circuit_breaker_until = COALESCE(?, circuit_breaker_until),
                       updated_at = datetime('now')`,
                )
                .bind(provider, modelApiId, status, newRate, circuitBreakerUntil, status, newRate, circuitBreakerUntil)
                .run();

            // Invalidate KV cache so next isHealthy() reads the degraded/down status
            await this.kv.delete(`health:${provider}:${modelApiId}`);
        } catch {
            // Non-critical
        }
    }

    /**
     * Get all provider health statuses (for dashboard).
     */
    async getAllStatuses(): Promise<ProviderHealthStatus[]> {
        try {
            const result = await this.db.prepare("SELECT * FROM provider_health ORDER BY provider, model_api_id").all<ProviderHealthRow>();

            return (result.results ?? []).map((row) => {
                return {
                    avgLatency5mMs: row["avg_latency_5m_ms"],
                    circuitBreakerUntil: row["circuit_breaker_until"],
                    errorRate5m: row["error_rate_5m"],
                    modelApiId: row["model_api_id"],
                    provider: row["provider"],
                    status: row["status"] as "healthy" | "degraded" | "down",
                };
            });
        } catch {
            return [];
        }
    }
}

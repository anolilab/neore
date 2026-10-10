/**
 * Daily usage aggregation queries for the usage dashboard.
 */
import type { AppEnv } from "../env.js";

export interface DailyUsage {
    avgLatencyMs: number;
    completionTokens: number;
    date: string;
    errorCount: number;
    modelId: string;
    orgId: string | null;
    promptTokens: number;
    requestCount: number;
    totalCostMicrodollars: number;
    userId: string;
}

export interface UsageSummary {
    byModel: Record<string, { cost: number; requests: number; tokens: number }>;
    period: string;
    totalCompletionTokens: number;
    totalCostMicrodollars: number;
    totalPromptTokens: number;
    totalRequests: number;
}

export class UsageAggregator {
    private db: D1Database;

    constructor(env: AppEnv) {
        this.db = env.USAGE_DB;
    }

    /**
     * Get usage summary for a user over a given period.
     */
    async getUserUsage(userId: string, days: number = 30): Promise<UsageSummary> {
        const since = new Date(Date.now() - days * 86_400_000).toISOString();

        const result = await this.db
            .prepare(
                `SELECT
                    model_id,
                    COUNT(*) as request_count,
                    SUM(prompt_tokens) as total_prompt,
                    SUM(completion_tokens) as total_completion,
                    SUM(cost_microdollars) as total_cost,
                    SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) as error_count
                 FROM usage_log
                 WHERE user_id = ? AND created_at >= ?
                 GROUP BY model_id`,
            )
            .bind(userId, since)
            .all();

        const rows = result.results ?? [];

        const byModel: Record<string, { cost: number; requests: number; tokens: number }> = {};
        let totalRequests = 0;
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let totalCostMicrodollars = 0;

        for (const row of rows) {
            const modelId = row["model_id"] as string;
            const requests = row["request_count"] as number;
            const prompt = row["total_prompt"] as number;
            const completion = row["total_completion"] as number;
            const cost = row["total_cost"] as number;

            byModel[modelId] = { cost, requests, tokens: prompt + completion };
            totalRequests += requests;
            totalPromptTokens += prompt;
            totalCompletionTokens += completion;
            totalCostMicrodollars += cost;
        }

        return {
            byModel,
            period: `${days}d`,
            totalCompletionTokens,
            totalCostMicrodollars,
            totalPromptTokens,
            totalRequests,
        };
    }

    /**
     * Materialize daily aggregates from usage_log into usage_daily.
     * Called by scheduled cron.
     */
    async materializeDailyAggregates(date?: string): Promise<void> {
        const targetDate = date ?? new Date().toISOString().slice(0, 10);

        await this.db
            .prepare(
                `INSERT OR REPLACE INTO usage_daily (user_id, org_id, model_id, date, request_count, prompt_tokens, completion_tokens, total_cost_microdollars, avg_latency_ms, error_count)
                 SELECT
                    user_id, COALESCE(org_id, '') as org_id, model_id,
                    DATE(created_at) as date,
                    COUNT(*) as request_count,
                    SUM(prompt_tokens) as prompt_tokens,
                    SUM(completion_tokens) as completion_tokens,
                    SUM(cost_microdollars) as total_cost_microdollars,
                    AVG(latency_ms) as avg_latency_ms,
                    SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) as error_count
                 FROM usage_log
                 WHERE DATE(created_at) = ?
                 GROUP BY user_id, org_id, model_id, DATE(created_at)`,
            )
            .bind(targetDate)
            .run();
    }

    /**
     * Delete old usage_log rows that have already been aggregated into usage_daily.
     * Retains the last `retentionDays` of raw data (default: 90 days).
     * Called by scheduled cron after materializeDailyAggregates.
     *
     * Only deletes rows whose date exists in usage_daily (safety check),
     * and batches deletes to stay within D1 CPU limits.
     */
    async cleanupOldUsageLogs(retentionDays: number = 90, batchSize: number = 5000): Promise<number> {
        const cutoffDate = new Date(Date.now() - retentionDays * 86_400_000).toISOString().slice(0, 10);
        let totalDeleted = 0;

        // Delete in batches to avoid hitting D1 CPU limits on large datasets

        while (true) {
            const result = await this.db
                .prepare(
                    `DELETE FROM usage_log WHERE rowid IN (
                        SELECT usage_log.rowid FROM usage_log
                        INNER JOIN usage_daily ON DATE(usage_log.created_at) = usage_daily.date
                            AND usage_log.user_id = usage_daily.user_id
                            AND usage_log.model_id = usage_daily.model_id
                        WHERE DATE(usage_log.created_at) < ?
                        LIMIT ?
                    )`,
                )
                .bind(cutoffDate, batchSize)
                .run();

            const deleted = result.meta?.changes ?? 0;

            totalDeleted += deleted;

            if (deleted < batchSize) {
                break; // No more rows to delete
            }
        }

        return totalDeleted;
    }
}

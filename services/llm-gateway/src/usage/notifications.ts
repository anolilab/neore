/**
 * Notification rules engine for cost/usage threshold alerts.
 *
 * Evaluates rules after each usage_log insert. Can trigger:
 *   - notify: send notification to user (via a backend webhook)
 *   - block: reject future requests until period resets
 *   - notify_and_block: both
 */
import type { AppEnv } from "../env.js";
import type { UsageLogEntry } from "./tracker.js";

export interface NotificationEvent {
    action: "notify" | "block" | "notify_and_block";
    currentValue: number;
    metric: string;
    ruleId: string;
    ruleName: string;
    threshold: number;
}

/** Cooldown: don't re-trigger the same rule within 1 hour */
const COOLDOWN_MS = 3_600_000;

export const evaluateRules = async (
    env: AppEnv,
    userId: string,
    orgId: string | undefined,
    newUsage: UsageLogEntry,
): Promise<{ blocked: boolean; notifications: NotificationEvent[] }> => {
    const database = env.USAGE_DB;
    const notifications: NotificationEvent[] = [];
    let isBlocked = false;

    try {
        // Fetch active rules for this user
        const rulesResult = await database.prepare("SELECT * FROM notification_rules WHERE user_id = ? AND is_active = 1").bind(userId).all();

        const rules = rulesResult.results ?? [];

        for (const rule of rules) {
            const ruleId = rule["id"] as string;
            const lastTriggered = rule["last_triggered_at"] as string | null;

            // Check cooldown
            if (lastTriggered && Date.now() - new Date(lastTriggered).getTime() < COOLDOWN_MS) {
                continue;
            }

            const modelFilter = rule["model_filter"] as string | null;

            // Apply model filter
            if (modelFilter && newUsage.modelId !== modelFilter) {
                continue;
            }

            const metric = rule["metric"] as string;
            const threshold = rule["threshold"] as number;
            const period = rule["period"] as string;
            const action = rule["action"] as "notify" | "block" | "notify_and_block";

            // Query current aggregated value for the rule's period
            const currentValue = await getMetricValue(database, userId, metric, period);

            if (currentValue >= threshold) {
                if (action === "block" || action === "notify_and_block") {
                    isBlocked = true;
                }

                if (action === "notify" || action === "notify_and_block") {
                    notifications.push({
                        action,
                        currentValue,
                        metric,
                        ruleId,
                        ruleName: rule["name"] as string,
                        threshold,
                    });
                }

                // Update last_triggered_at
                await database.prepare("UPDATE notification_rules SET last_triggered_at = datetime('now') WHERE id = ?").bind(ruleId).run();
            }
        }
    } catch (error) {
        console.error("[Notifications] Rule evaluation failed:", error);
        // Don't block on evaluation failure
    }

    return { blocked: isBlocked, notifications };
};

const getMetricValue = async (database: D1Database, userId: string, metric: string, period: string): Promise<number> => {
    const since = getPeriodStart(period);

    switch (metric) {
        case "daily_cost":
        case "monthly_cost": {
            const result = await database
                .prepare("SELECT SUM(cost_microdollars) as total FROM usage_log WHERE user_id = ? AND created_at >= ?")
                .bind(userId, since)
                .first<{ total: number | null }>();

            return result?.total ?? 0;
        }
        case "request_count": {
            const result = await database
                .prepare("SELECT COUNT(*) as total FROM usage_log WHERE user_id = ? AND created_at >= ?")
                .bind(userId, since)
                .first<{ total: number | null }>();

            return result?.total ?? 0;
        }
        case "token_count": {
            const result = await database
                .prepare("SELECT SUM(prompt_tokens + completion_tokens) as total FROM usage_log WHERE user_id = ? AND created_at >= ?")
                .bind(userId, since)
                .first<{ total: number | null }>();

            return result?.total ?? 0;
        }
        default: {
            return 0;
        }
    }
};

const getPeriodStart = (period: string): string => {
    const now = new Date();

    switch (period) {
        case "day": {
            return new Date(now.getTime() - 86_400_000).toISOString();
        }
        case "hour": {
            return new Date(now.getTime() - 3_600_000).toISOString();
        }
        case "month": {
            return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        }
        default: {
            return new Date(now.getTime() - 86_400_000).toISOString();
        }
    }
};

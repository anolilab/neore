/**
 * Usage tracker: writes usage_log entries to D1 after each LLM call,
 * then evaluates notification rules for threshold alerts.
 */
import type { AppEnv } from "../env.js";
import type { RequestTelemetry } from "../lib/otel/index.js";
import { SpanKind } from "../lib/otel/index.js";
import { buildEvent, deliverEvent } from "../lib/webhook-delivery.js";
import type { NotificationEvent } from "./notifications.js";
import { evaluateRules } from "./notifications.js";

export interface UsageLogEntry {
    apiKeyId?: string;
    cachedTokens: number;
    completionTokens: number;
    costMicrodollars: number;
    errorCode?: string;
    /** Fallback reason if this request was served by a fallback model: 'infra' | 'content_policy' | 'context_overflow' */
    fallbackReason?: string;
    finishReason?: string;
    /** JSON-serialized array of guardrail violations detected in this request */
    guardrailViolations?: string;
    /** True when the structured output response was repaired by the gateway healing pipeline */
    healed?: boolean;
    isStreaming: boolean;
    latencyMs: number;
    modelApiId: string;
    modelId: string;
    /** What the call was, as OpenTelemetry's GenAI conventions name it. Set it and the call also exports as a GenAI span. */
    operation?: "chat" | "embeddings";
    orgId?: string;
    promptTokens: number;
    provider: string;
    reasoningTokens: number;
    requestId: string;
    routedModelId?: string;
    routingConfidence?: number;
    source: "internal" | "saas_api";
    threadId?: string;
    ttftMs?: number;
    userId: string;
}

export interface RecordResult {
    blocked: boolean;
    notifications: NotificationEvent[];
}

export class UsageTracker {
    /**
     * Emit OTel metrics for a usage entry. Caller passes the per-request
     * telemetry collector (typically `c.var.telemetry`). When telemetry is
     * disabled the collector itself no-ops, so this is safe to always call.
     */
    static recordMetrics(telemetry: RequestTelemetry, entry: UsageLogEntry): void {
        const labels = {
            error: entry.errorCode ?? "ok",
            model: entry.modelId,
            provider: entry.provider,
            // Whether the gateway picked the model (auto-routed) or the caller
            // specified it. NOT a routing tier — those live on
            // `gateway.routing_decisions_total`.
            routing_source: entry.routedModelId ? "auto" : "explicit",
            source: entry.source,
            streaming: entry.isStreaming,
        };

        if (entry.operation) {
            this.recordGenAiSpan(telemetry, entry, entry.operation);
        }

        telemetry.recordCounter("gateway.tokens_total", entry.promptTokens, { ...labels, kind: "prompt" }, "1");
        telemetry.recordCounter("gateway.tokens_total", entry.completionTokens, { ...labels, kind: "completion" }, "1");

        if (entry.cachedTokens > 0) {
            telemetry.recordCounter("gateway.tokens_total", entry.cachedTokens, { ...labels, kind: "cached" }, "1");
        }

        if (entry.reasoningTokens > 0) {
            telemetry.recordCounter("gateway.tokens_total", entry.reasoningTokens, { ...labels, kind: "reasoning" }, "1");
        }

        telemetry.recordCounter("gateway.cost_microdollars_total", entry.costMicrodollars, labels, "1");
        telemetry.recordHistogram("gateway.provider_latency", entry.latencyMs, labels, "ms");

        if (entry.ttftMs !== undefined) {
            telemetry.recordHistogram("gateway.ttft", entry.ttftMs, labels, "ms");
        }

        if (entry.fallbackReason) {
            telemetry.recordCounter("gateway.fallbacks_total", 1, { ...labels, fallback_reason: entry.fallbackReason }, "1");
        }

        if (entry.errorCode) {
            telemetry.recordCounter("gateway.errors_total", 1, { ...labels, error_code: entry.errorCode }, "1");
        }
    }

    /**
     * One span per model call in OpenTelemetry's GenAI conventions
     * (`gen_ai.*`), which LLM-aware backends read to show a call as a
     * generation, with its model, token counts and latency. The caller's user
     * id and the prompt are NOT attached: spans go to an operator-chosen
     * collector, and neither is needed to read a trace.
     */
    private static recordGenAiSpan(telemetry: RequestTelemetry, entry: UsageLogEntry, operation: "chat" | "embeddings"): void {
        telemetry.recordSpan(`${operation} ${entry.modelApiId}`, {
            attributes: {
                "gateway.cost_microdollars": entry.costMicrodollars,
                "gateway.finish_reason": entry.finishReason,
                "gateway.request_id": entry.requestId,
                "gen_ai.operation.name": operation,
                "gen_ai.provider.name": entry.provider,
                "gen_ai.request.model": entry.modelApiId,
                "gen_ai.response.model": entry.routedModelId ?? entry.modelApiId,
                "gen_ai.system": entry.provider,
                "gen_ai.usage.input_tokens": entry.promptTokens,
                ...(operation === "chat" && { "gen_ai.usage.output_tokens": entry.completionTokens }),
            },
            durationMs: entry.latencyMs,
            error: entry.errorCode ? new Error(entry.errorCode) : undefined,
            kind: SpanKind.CLIENT,
        });
    }

    private db: D1Database;

    private env: AppEnv;

    constructor(env: AppEnv) {
        this.db = env.USAGE_DB;
        this.env = env;
    }

    /**
     * Record a usage log entry to D1. Optionally emit OTel metrics — pass
     * `c.var.telemetry` to get token/cost/latency histograms and counters
     * exported alongside the D1 row.
     */
    async record(entry: UsageLogEntry, telemetry?: RequestTelemetry): Promise<void> {
        // Before the first await: a handler that calls this synchronously has its metrics
        // buffered before the middleware's flush.
        if (telemetry) UsageTracker.recordMetrics(telemetry, entry);

        const id = crypto.randomUUID();

        try {
            await this.db
                .prepare(
                    `INSERT INTO usage_log (
                        id, request_id, user_id, org_id, thread_id,
                        model_id, provider, model_api_id, routed_model_id, routing_confidence,
                        prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
                        cost_microdollars, latency_ms, ttft_ms,
                        is_streaming, finish_reason, error_code, source, api_key_id,
                        guardrail_violations, fallback_reason, healed
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    id,
                    entry.requestId,
                    entry.userId,
                    entry.orgId ?? null,
                    entry.threadId ?? null,
                    entry.modelId,
                    entry.provider,
                    entry.modelApiId,
                    entry.routedModelId ?? null,
                    entry.routingConfidence ?? null,
                    entry.promptTokens,
                    entry.completionTokens,
                    entry.cachedTokens,
                    entry.reasoningTokens,
                    entry.costMicrodollars,
                    entry.latencyMs,
                    entry.ttftMs ?? null,
                    entry.isStreaming ? 1 : 0,
                    entry.finishReason ?? null,
                    entry.errorCode ?? null,
                    entry.source,
                    entry.apiKeyId ?? null,
                    entry.guardrailViolations ?? null,
                    entry.fallbackReason ?? null,
                    entry.healed ? 1 : 0,
                )
                .run();
        } catch (error) {
            // Usage tracking is non-blocking — log and continue
            console.error("[UsageTracker] Failed to record usage:", error);
        }

        await flushQuietly(telemetry);
    }

    /**
     * Record usage and evaluate notification rules.
     * Returns whether the user should be blocked and any triggered notifications.
     *
     * When `telemetry` is provided, OTel metrics are emitted with the D1 write, and
     * the request's telemetry is flushed once more at the end. A streamed reply
     * records here after the middleware has already flushed, so this is what exports it.
     */
    async recordAndEvaluate(entry: UsageLogEntry, telemetry?: RequestTelemetry): Promise<RecordResult> {
        if (telemetry) UsageTracker.recordMetrics(telemetry, entry);

        try {
            await this.record(entry);

            return await evaluateAndNotify(this.env, this.db, entry);
        } finally {
            await flushQuietly(telemetry);
        }
    }

    /**
     * Check if a user is currently blocked by budget rules.
     */
    async isUserBlocked(userId: string): Promise<boolean> {
        try {
            const blockedUntil = await this.env.RATE_LIMIT_KV.get(`blocked:${userId}`);

            if (!blockedUntil) return false;

            return new Date(blockedUntil).getTime() > Date.now();
        } catch {
            return false;
        }
    }
}

const evaluateAndNotify = async (env: AppEnv, db: D1Database, entry: UsageLogEntry): Promise<RecordResult> => {
    const result = await evaluateRules(env, entry.userId, entry.orgId, entry);

    // If blocked, store in KV for pre-request checks (1-hour TTL) and fire budget_exceeded webhook
    if (result.blocked) {
        const kv = env.RATE_LIMIT_KV;

        try {
            await kv.put(`blocked:${entry.userId}`, new Date(Date.now() + 3_600_000).toISOString(), { expirationTtl: 3600 });
        } catch {
            // Non-critical
        }

        // Fire budget_exceeded webhook (non-blocking, best-effort)
        deliverEvent(
            db,
            buildEvent(
                "budget_exceeded",
                entry.userId,
                {
                    costMicrodollars: entry.costMicrodollars,
                    modelId: entry.modelId,
                    requestId: entry.requestId,
                },
                entry.orgId,
            ),
        ).catch(() => {
            // Non-critical
        });
    }

    // Forward notifications to the backend if any were triggered
    if (result.notifications.length > 0) {
        try {
            await sendNotifications(env, entry.userId, result.notifications);
        } catch {
            // Non-critical — notifications are best-effort
        }
    }

    return result;
};

/** Telemetry must never fail the caller, so an export error is dropped here. */
const flushQuietly = async (telemetry: RequestTelemetry | undefined): Promise<void> => {
    try {
        await telemetry?.flush();
    } catch {
        // Non-critical
    }
};

/** The backend refuses a larger batch (`MAX_NOTIFICATIONS_PER_REQUEST`), so a user with many firing rules is sent in slices. */
const NOTIFICATIONS_PER_REQUEST = 50;

const postNotifications = async (lunoraUrl: string, secret: string, userId: string, notifications: NotificationEvent[]): Promise<void> => {
    const body = JSON.stringify({ notifications, userId });
    const timestamp = Date.now().toString();
    const bodyHash = await sha256Hex(new TextEncoder().encode(body));
    const message = `POST\n/gateway/notifications\n${timestamp}\n${bodyHash}`;
    const signature = await hmacSha256Hex(secret, message);

    const response = await fetch(`${lunoraUrl}/gateway/notifications`, {
        body,
        headers: { "Content-Type": "application/json", "X-Signature": signature, "X-Timestamp": timestamp },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
    });

    // Log before the body is released, so a cancel that throws cannot hide the status.
    // Status and rule actions only — the payload names a user and their spend.
    if (!response.ok) {
        console.error("[Notifications] Backend rejected usage notifications", { actions: notifications.map((n) => n.action), status: response.status });
    }

    // Nothing reads the reply; cancel it so the Worker releases the connection.
    await response.body?.cancel();
};

export const sendNotifications = async (env: AppEnv, userId: string, notifications: NotificationEvent[]): Promise<void> => {
    const lunoraUrl = env.LUNORA_URL;
    const secret = env.SIGNING_SECRET;

    if (!lunoraUrl || !secret) return;

    for (let offset = 0; offset < notifications.length; offset += NOTIFICATIONS_PER_REQUEST) {
        const slice = notifications.slice(offset, offset + NOTIFICATIONS_PER_REQUEST);

        try {
            await postNotifications(lunoraUrl, secret, userId, slice);
        } catch (error) {
            // Best-effort, but never silent: a timeout or a dropped connection is otherwise lost. No retry, no payload.
            console.error("[Notifications] Failed to deliver usage notifications", {
                actions: slice.map((n) => n.action),
                error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
            });
        }
    }
};

const sha256Hex = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

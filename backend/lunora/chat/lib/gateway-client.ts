/**
 * Backend -> LLM Gateway client.
 *
 * Utilities for calling the LLM Gateway's internal API from actions, over the
 * gateway's service binding (`ctx.services.llmGateway`, its `InternalApi`
 * entrypoint — `lib/services.ts`). Uses `@neore/service-sdk` for the typed SDK
 * calls; nothing is signed, because the binding is the only way in.
 */
import type { JSONSchema7, JSONValue } from "@ai-sdk/provider";
import {
    createLlmGatewayClient,
    getUsage as sdkGetUsage,
    internalGenerate as sdkInternalGenerate,
    internalRoute as sdkInternalRoute,
} from "@neore/service-sdk/llm-gateway";

import type { ActionCtx as ActionContext } from "../../_generated/server";
import { FETCH_TIMEOUT_LONG_MS, FETCH_TIMEOUT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";
import { gatewayFetch, SERVICE_ORIGIN, type ServicesContext } from "../../lib/services.js";
import { generateTraceparent } from "../../lib/traceparent.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelFilterRules {
    allowedModels?: string[];
    allowedProviders?: string[];
    allowedRegions?: string[];
    blockedModels?: string[];
    blockedProviders?: string[];
    blockedRegions?: string[];
    denyDataCollection?: boolean;
    requireZDR?: boolean;
}

export interface GatewayStreamRequest {
    maxTokens?: number;
    messages: unknown[];
    modelApiId: string;
    modelFilterRules?: ModelFilterRules;
    modelId: string;
    orgId?: string;
    provider: string;
    providerApiKey?: string;
    providerOptions?: Record<string, JSONValue>;
    requestId: string;
    system?: string;
    temperature?: number;
    threadId?: string;
    toolSchemas?: Record<string, { description: string; parameters: JSONSchema7 }>;

    /**
     * Optional W3C `traceparent` to propagate. When unset, a fresh traceparent
     * is generated so each gateway call still produces a complete trace.
     */
    traceparent?: string;
    userId: string;
}

export interface GatewayGenerateRequest {
    maxTokens?: number;
    messages: unknown[];
    modelApiId: string;
    modelFilterRules?: ModelFilterRules;
    modelId: string;
    orgId?: string;
    provider: string;
    providerApiKey?: string;
    providerOptions?: Record<string, JSONValue>;
    requestId: string;
    system?: string;
    temperature?: number;
    threadId?: string;
    /** Optional W3C `traceparent` for cross-service trace propagation. */
    traceparent?: string;
    userId: string;
}

export interface GenerateResult {
    cost: { microdollars: number; pricingAvailable: boolean };
    finishReason: string;
    latencyMs: number;
    text: string;
    usage: {
        cachedTokens?: number;
        completionTokens: number;
        promptTokens: number;
        reasoningTokens?: number;
    };
}

export interface RouteRequest {
    /**
     * Optional user-pinned (provider, modelId) per specificity category.
     * Categories: coding, web_browsing, data_analysis, image_generation,
     * video_generation, social_media, email_management, calendar_management,
     * trading. When the active query classifies into a pinned category with
     * ≥ 0.9 confidence, the gateway uses the pin and bypasses tier routing.
     */
    categoryPins?: Record<string, { modelId: string; provider: string }>;
    messages: unknown[];
    modelFilterRules?: ModelFilterRules;
    preferredModel?: string;
    preferredQuality?: number;
    threadId?: string;
    toolSchemas?: Record<string, JSONSchema7>;
    /** Optional W3C `traceparent` for cross-service trace propagation. */
    traceparent?: string;

    /**
     * Optional thread/user identifiers for session momentum (sticky tier
     * routing). Both must be present for momentum to apply.
     */
    userId?: string;
    userTier: string;
}

export interface RouteClassification {
    confidence: number;
    isComplex: boolean;
    requiresPlanning: boolean;
    requiresValidation: boolean;
    searchMode: "chat" | "web" | "academic";
    taskType: "general" | "research" | "coding" | "data-analysis" | "writing";
}

export interface RouteResult {
    alternativeModelId?: string;
    classification?: RouteClassification;
    confidence: number;
    estimatedCost: number;
    modelApiId: string;
    modelId: string;
    provider: string;
    routingReason: string;
    tier: string;
}

export interface StreamChunk {
    [key: string]: unknown;
    type: "text-delta" | "reasoning" | "tool-call" | "step-finish" | "finish" | "error";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * An SDK client on this action's gateway binding. Built per call, never cached
 * at module level: the binding belongs to the request whose `ctx` carries it.
 */
const getGatewayClient = (context: ServicesContext) => createLlmGatewayClient({ fetch: gatewayFetch(context) });

/** A URL on the gateway's internal API. The host is a placeholder; the binding routes by path. */
const gatewayUrl = (pathAndQuery: string): string => `${SERVICE_ORIGIN.llmGateway}${pathAndQuery}`;

/**
 * Non-streaming LLM call via the gateway.
 * Used for title generation, classification, memory extraction, etc.
 */
export const generateViaGateway = async (context: ActionContext, request: GatewayGenerateRequest): Promise<GenerateResult> => {
    const client = getGatewayClient(context);
    const traceparent = request.traceparent ?? generateTraceparent();

    const { data, error, response } = await sdkInternalGenerate({
        body: request as Parameters<typeof sdkInternalGenerate>[0]["body"],
        client,
        headers: { traceparent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS),
    });

    if (error || !response?.ok) {
        throw new Error(`Gateway generate failed (${response?.status ?? "no response"}): ${JSON.stringify(error)}`);
    }

    return data as GenerateResult;
};

/**
 * Streaming LLM call via the gateway.
 * Returns an async iterable of parsed SSE chunks.
 */
export async function* streamViaGateway(context: ActionContext, request: GatewayStreamRequest): AsyncGenerator<StreamChunk> {
    const traceparent = request.traceparent ?? generateTraceparent();

    // Deliberately NOT `fetchWithDeadline`. This response is consumed as a
    // stream (`response.body.getReader()` below), and `AbortSignal.timeout`
    // bounds the WHOLE request including the body — so a deadline here would
    // truncate a long but perfectly healthy generation. The gateway's own
    // `cpu_ms` limit is what bounds this call.
    const response = await gatewayFetch(context)(gatewayUrl("/internal/stream"), {
        body: JSON.stringify(request),
        headers: {
            "Content-Type": "application/json",
            traceparent,
        },
        method: "POST",
    });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway stream failed (${response.status}): ${errorBody}`);
    }

    if (!response.body) {
        throw new Error("Gateway stream returned no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE lines
            const lines = buffer.split("\n\n");

            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;

                try {
                    const chunk = JSON.parse(line.slice(6)) as StreamChunk;

                    yield chunk;
                } catch {
                    // Skip malformed SSE lines
                }
            }
        }

        // Process remaining buffer
        if (buffer.startsWith("data: ")) {
            try {
                const chunk = JSON.parse(buffer.slice(6)) as StreamChunk;

                yield chunk;
            } catch {
                // Skip
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Smart model selection via the gateway.
 */
export const routeViaGateway = async (context: ActionContext, request: RouteRequest): Promise<RouteResult> => {
    const client = getGatewayClient(context);
    const traceparent = request.traceparent ?? generateTraceparent();

    const { data, error, response } = await sdkInternalRoute({
        body: request as Parameters<typeof sdkInternalRoute>[0]["body"],
        client,
        headers: { traceparent },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (error || !response?.ok) {
        throw new Error(`Gateway route failed (${response?.status ?? "no response"}): ${JSON.stringify(error)}`);
    }

    return data as RouteResult;
};

// ── Routing Analytics ─────────────────────────────────────────────────────────

export interface RoutingAnalytics {
    costTrend: { costMicrodollars: number; date: string; requestCount: number }[];
    modelBreakdown: {
        avgLatencyMs: number;
        costMicrodollars: number;
        count: number;
        errorCount: number;
        modelId: string;
        provider: string;
    }[];
    overview: {
        avgLatencyMs: number;
        cacheHitRate: number;
        errorRate: number;
        totalCostMicrodollars: number;
        totalRequests: number;
    };
    period: "24h" | "7d";
    providerHealth: {
        avgLatency5mMs: number;
        circuitBreakerUntil: string | null;
        errorRate5m: number;
        lastFailureAt: string | null;
        lastSuccessAt: string | null;
        modelApiId: string;
        provider: string;
        status: string;
    }[];
    tierDistribution: { count: number; tier: string }[];
}

/**
 * Fetch routing analytics from the gateway admin endpoint.
 */
export const getRoutingAnalytics = async (context: ActionContext, period: "24h" | "7d" = "24h"): Promise<RoutingAnalytics> => {
    // Defense-in-depth: pass the requesting admin's user ID so the gateway can
    // verify against its GATEWAY_ADMIN_USER_IDS allowlist.
    const identity = await context.auth.getIdentity();
    // `getIdentity()` resolves to `Record<string, unknown> | null`, so `subject`
    // is `unknown` — and it goes straight into the request's query string.
    const adminUserId = identity?.subject;

    if (typeof adminUserId !== "string") {
        throw new TypeError("Gateway analytics requires an authenticated admin user");
    }

    const params = new URLSearchParams({ adminUserId, period });

    const response = await fetchWithDeadline(gatewayUrl(`/internal/admin/routing-analytics?${params.toString()}`), {
        method: "GET",
        via: gatewayFetch(context),
    });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway analytics failed (${response.status}): ${errorBody}`);
    }

    return (await response.json()) as RoutingAnalytics;
};

// ── User Usage ────────────────────────────────────────────────────────────────

export interface UserUsageSummary {
    byModel: Record<string, { cost: number; requests: number; tokens: number }>;
    dailyBreakdown: { completionTokens: number; costMicrodollars: number; date: string; promptTokens: number; requestCount: number }[];
    period: string;
    totalCompletionTokens: number;
    totalCostMicrodollars: number;
    totalPromptTokens: number;
    totalRequests: number;
}

/**
 * Fetch per-user usage summary from the gateway (last N days).
 */
export const getUserUsageFromGateway = async (context: ActionContext, userId: string, days: number = 30): Promise<UserUsageSummary> => {
    const client = getGatewayClient(context);

    const { data, error, response } = await sdkGetUsage({
        client,
        query: { period: String(days), userId },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (error || !response?.ok || !data) {
        throw new Error(`Gateway usage failed (${response?.status ?? "no response"}): ${JSON.stringify(error)}`);
    }

    const summary = data as unknown as UserUsageSummary;

    return {
        byModel: summary.byModel ?? {},
        dailyBreakdown: summary.dailyBreakdown ?? [],
        period: summary.period ?? `${days}d`,
        totalCompletionTokens: summary.totalCompletionTokens ?? 0,
        totalCostMicrodollars: summary.totalCostMicrodollars ?? 0,
        totalPromptTokens: summary.totalPromptTokens ?? 0,
        totalRequests: summary.totalRequests ?? 0,
    };
};

// ── Notification Rules ────────────────────────────────────────────────────────

export interface NotificationRule {
    action: "notify" | "block" | "notify_and_block";
    createdAt: string;
    id: string;
    isActive: boolean;
    lastTriggeredAt: string | null;
    metric: "daily_cost" | "monthly_cost" | "request_count" | "token_count";
    modelFilter: string | null;
    name: string;
    orgId: string | null;
    period: "hour" | "day" | "month";
    threshold: number;
    userId: string;
}

export interface CreateNotificationRuleRequest {
    action?: NotificationRule["action"];
    metric: NotificationRule["metric"];
    modelFilter?: string;
    name: string;
    orgId?: string;
    period?: NotificationRule["period"];
    threshold: number;
    userId: string;
}

/**
 * List notification rules for a user.
 */
export const listNotificationRules = async (context: ActionContext, userId: string): Promise<NotificationRule[]> => {
    const response = await fetchWithDeadline(gatewayUrl(`/internal/notification-rules?userId=${encodeURIComponent(userId)}`), {
        method: "GET",
        via: gatewayFetch(context),
    });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway notification rules fetch failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as { rules: NotificationRule[] };

    return data.rules ?? [];
};

/**
 * Create a new notification rule.
 */
export const createNotificationRule = async (context: ActionContext, request: CreateNotificationRuleRequest): Promise<NotificationRule> => {
    const response = await fetchWithDeadline(gatewayUrl("/internal/notification-rules"), {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        via: gatewayFetch(context),
    });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway create notification rule failed (${response.status}): ${errorBody}`);
    }

    return (await response.json()) as NotificationRule;
};

/**
 * Delete a notification rule by ID.
 */
export const deleteNotificationRule = async (context: ActionContext, ruleId: string, userId: string): Promise<void> => {
    const response = await fetchWithDeadline(gatewayUrl(`/internal/notification-rules/${encodeURIComponent(ruleId)}?userId=${encodeURIComponent(userId)}`), {
        method: "DELETE",
        via: gatewayFetch(context),
    });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway delete notification rule failed (${response.status}): ${errorBody}`);
    }
};

// ── Virtual API Key Management ────────────────────────────────────────────────

export interface GatewayApiKey {
    createdAt: string;
    expiresAt: string | null;
    isActive: boolean;
    keyId: string;
    lastUsedAt: string | null;
    maxBudgetUsd: number | null;
    name: string;
    prefix: string;
    rpmLimit: number;
    spentUsd: number;
    tier: string;
    tpmLimit: number;
}

export interface CreateGatewayKeyRequest {
    expiresAt?: string;
    maxBudgetUsd?: number;
    name?: string;
    orgId?: string;
    rpmLimit?: number;
    tier?: "free" | "pro" | "enterprise";
    tpmLimit?: number;
    userId: string;
}

export interface CreatedGatewayKey extends GatewayApiKey {
    rawKey: string; // shown exactly once
}

/**
 * List virtual API keys for a user.
 */
export const listGatewayKeys = async (context: ActionContext, userId: string): Promise<GatewayApiKey[]> => {
    const response = await fetchWithDeadline(gatewayUrl(`/internal/keys?userId=${encodeURIComponent(userId)}`), { method: "GET", via: gatewayFetch(context) });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway list keys failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as { keys: GatewayApiKey[] };

    return data.keys ?? [];
};

/**
 * Create a new virtual API key.
 */
export const createGatewayKey = async (context: ActionContext, request: CreateGatewayKeyRequest): Promise<CreatedGatewayKey> => {
    const response = await fetchWithDeadline(gatewayUrl("/internal/keys"), {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        via: gatewayFetch(context),
    });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway create key failed (${response.status}): ${errorBody}`);
    }

    return (await response.json()) as CreatedGatewayKey;
};

/**
 * Revoke a virtual API key.
 */
export const revokeGatewayKey = async (context: ActionContext, keyId: string): Promise<void> => {
    const response = await fetchWithDeadline(gatewayUrl(`/internal/keys/${encodeURIComponent(keyId)}`), { method: "DELETE", via: gatewayFetch(context) });

    if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(`Gateway revoke key failed (${response.status}): ${errorBody}`);
    }
};

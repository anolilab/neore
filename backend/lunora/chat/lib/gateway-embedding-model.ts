/**
 * Gateway Embedding Model — EmbeddingModelV3 adapter that routes embedding
 * calls through the LLM Gateway for centralized usage tracking and billing.
 *
 * Replaces direct `@ai-sdk/google` and CF Workers AI embedding calls.
 */
import type { EmbeddingModelV3, EmbeddingModelV3CallOptions, EmbeddingModelV3Result } from "@ai-sdk/provider";

import { fetchWithDeadline } from "../../lib/fetch-timeout";
import { SERVICE_ORIGIN, type ServiceFetch } from "../../lib/services.js";
import { generateTraceparent } from "../../lib/traceparent.js";

export interface GatewayEmbeddingModelOptions {
    /** The gateway's service binding (`gatewayFetch(ctx)`). */
    gateway: ServiceFetch;
    modelId: string;
    orgId?: string;
    threadId?: string;

    /**
     * Optional W3C `traceparent` header value. All doEmbed calls on this
     * instance share the same value so the gateway groups them into one
     * distributed trace. When unset, a fresh traceparent is generated.
     */
    traceparent?: string;
    userId?: string;
}

/**
 * An EmbeddingModelV3-compatible model that proxies embedding calls
 * through the LLM Gateway's /internal/embeddings endpoint.
 */
export class GatewayEmbeddingModel implements EmbeddingModelV3 {
    readonly specificationVersion = "v3" as const;

    readonly modelId: string;

    readonly provider = "gateway";

    readonly maxEmbeddingsPerCall = 100;

    readonly supportsParallelCalls = false;

    private readonly gateway: ServiceFetch;

    private readonly userId: string;

    private readonly orgId?: string;

    private readonly threadId?: string;

    /**
     * Stable per-instance traceparent so multiple doEmbed calls on the
     * same model land in one distributed trace.
     */
    private readonly traceparent: string;

    constructor(options: GatewayEmbeddingModelOptions) {
        this.modelId = options.modelId;
        this.gateway = options.gateway;
        this.userId = options.userId ?? "system";
        this.orgId = options.orgId;
        this.threadId = options.threadId;
        this.traceparent = options.traceparent ?? generateTraceparent();
    }

    async doEmbed(options: EmbeddingModelV3CallOptions): Promise<EmbeddingModelV3Result> {
        const requestBody = JSON.stringify({
            input: options.values,
            model: this.modelId,
            orgId: this.orgId,
            requestId: `embed-${this.userId}-${Date.now()}`,
            threadId: this.threadId,
            userId: this.userId,
        });

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            traceparent: this.traceparent,
        };

        // Merge provider headers if provided
        if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) {
                if (value !== undefined) {
                    headers[key] = value;
                }
            }
        }

        const response = await fetchWithDeadline(`${SERVICE_ORIGIN.llmGateway}/internal/embeddings`, {
            body: requestBody,
            headers,
            method: "POST",
            signal: options.abortSignal,
            via: this.gateway,
        });

        if (!response.ok) {
            const errorBody = await response.text();

            throw new Error(`Gateway embedding failed (${response.status}): ${errorBody}`);
        }

        const result = (await response.json()) as {
            embeddings: number[][];
            usage?: { totalTokens: number };
        };

        return {
            embeddings: result.embeddings,
            usage: result.usage ? { tokens: result.usage.totalTokens } : undefined,
            warnings: [],
        };
    }
}

/**
 * Create a gateway embedding model for memory/knowledge embedding calls,
 * bound to the calling action's gateway binding (`gatewayFetch(ctx)`).
 */
export const createGatewayEmbeddingModel = (
    gateway: ServiceFetch,
    options?: { threadId?: string; traceparent?: string; userId?: string },
): GatewayEmbeddingModel =>
    new GatewayEmbeddingModel({
        gateway,
        modelId: "text-embedding-004",
        threadId: options?.threadId,
        traceparent: options?.traceparent,
        userId: options?.userId,
    });

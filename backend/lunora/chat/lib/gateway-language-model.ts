/**
 * Gateway Language Model — LanguageModelV3 implementation that proxies
 * doGenerate() and doStream() calls to the LLM Gateway over HTTP.
 *
 * This adapter plugs into the existing agent pipeline so that all
 * LLM calls go through the gateway (for token counting, cost tracking,
 * smart routing, provider health monitoring) without changing tool execution,
 * message persistence, or the multi-step agent loop.
 *
 * Every call goes through the gateway's service binding: the action that builds
 * the model hands it `gatewayFetch(ctx)` (`lib/services.ts`), so a model
 * instance is tied to the request that created it.
 */
import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3GenerateResult,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
    SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import type { CustomProviderFormat } from "@neore/ai/gateway";

import { GATEWAY_COST_METADATA_KEY } from "../../agent/message-cost.js";
import { SERVICE_ORIGIN, type ServiceFetch } from "../../lib/services.js";
import { generateTraceparent } from "../../lib/traceparent.js";

// ── Configuration ────────────────────────────────────────────────────────────

/** Model filter rules for geographic/compliance/privacy restrictions. */
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

/** A user-configured endpoint, forwarded as-is for `provider: "custom"`. */
export interface GatewayCustomProviderConfig {
    /** Bedrock: IAM access key id; `apiKey` is then its secret access key. */
    accessKeyId?: string;
    apiKey: string;
    /** Azure: api-version. */
    apiVersion?: string;
    baseUrl: string;
    format: CustomProviderFormat;
    id: string;
    /** Bedrock: AWS region. */
    region?: string;
}

export interface GatewayLanguageModelConfig {
    /** Required when `provider === "custom"` — the user's own endpoint (decrypted). */
    customProvider?: GatewayCustomProviderConfig;
    /** The gateway's service binding (`gatewayFetch(ctx)`) — every proxy call goes through it. */
    gateway: ServiceFetch;
    /** Provider-specific API model ID (e.g. "anthropic/claude-3.5-sonnet") */
    modelApiId: string;
    /** Optional model filter rules for geographic/compliance restrictions */
    modelFilterRules?: ModelFilterRules;
    /** Internal model ID (e.g. "claude-3-5-sonnet") */
    modelId: string;
    /** Org ID for usage tracking */
    orgId?: string;
    /** Provider key: "openrouter", "groq", "google", etc. */
    provider: string;
    /** Optional BYOK API key (decrypted) */
    providerApiKey?: string;
    /** Thread ID for usage tracking */
    threadId?: string;

    /**
     * Optional W3C `traceparent` header value to propagate to the gateway.
     * All doGenerate/doStream calls on this model instance share the same
     * traceparent so they land in one distributed trace. When unset, a
     * fresh traceparent is generated per instance (still produces a trace,
     * just not linked across multiple model instances).
     */
    traceparent?: string;
    /** User ID for usage tracking */
    userId?: string;
}

// ── Per-message cost ─────────────────────────────────────────────────────────

/** Response headers carrying the cost of a non-streaming (`generate`) proxy call. */
export const GATEWAY_COST_HEADER = "x-gateway-cost-microdollars";
export const GATEWAY_PRICING_AVAILABLE_HEADER = "x-gateway-pricing-available";

/**
 * Fold the gateway's cost into `providerMetadata` — of a stream's `finish` part
 * (from the trailing `gateway-metadata` event) or of a `doGenerate` result (from
 * the cost headers). Malformed cost data leaves the target unchanged.
 */
export const withGatewayCost = <T extends { providerMetadata?: SharedV3ProviderMetadata }>(
    target: T,
    gatewayMetadata: { cost?: { microdollars?: unknown; pricingAvailable?: unknown } },
    isByok: boolean,
): T => {
    const microdollars = gatewayMetadata.cost?.microdollars;

    if (typeof microdollars !== "number" || !Number.isFinite(microdollars)) {
        return target;
    }

    return {
        ...target,
        providerMetadata: {
            ...target.providerMetadata,
            [GATEWAY_COST_METADATA_KEY]: {
                byok: isByok,
                costMicrodollars: microdollars,
                pricingAvailable: gatewayMetadata.cost?.pricingAvailable !== false,
            },
        },
    };
};

// ── Serialization (Uint8Array ↔ base64, URL ↔ string, Date ↔ ISO) ───────────
// NOTE: This serialization logic is duplicated in services/llm-gateway/src/lib/model-serialization.ts.
// Both sides must stay in sync — if you add a tagged type here, add it there too.

interface TaggedBase64 {
    __gwType: "uint8array";
    data: string;
}

interface TaggedURL {
    __gwType: "url";
    href: string;
}

interface TaggedDate {
    __gwType: "date";
    iso: string;
}

type TaggedData = TaggedBase64 | TaggedURL | TaggedDate;

const isTagged = (value: unknown): value is TaggedData => typeof value === "object" && value !== null && "__gwType" in value;

const serializeForWire = <T>(object: T): T => {
    if (object === null || object === undefined) return object;

    if (object instanceof Uint8Array) {
        let binary = "";

        for (let i = 0; i < object.byteLength; i += 1) {
            binary += String.fromCodePoint(object[i]!);
        }

        return { __gwType: "uint8array", data: btoa(binary) } as unknown as T;
    }

    if (object instanceof Date) {
        return { __gwType: "date", iso: object.toISOString() } as unknown as T;
    }

    if (object instanceof URL) {
        return { __gwType: "url", href: object.toString() } as unknown as T;
    }

    if (Array.isArray(object)) {
        return object.map((item) => serializeForWire(item)) as unknown as T;
    }

    if (typeof object === "object") {
        const result: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
            if (key === "abortSignal") continue; // Non-serializable

            result[key] = serializeForWire(value);
        }

        return result as T;
    }

    return object;
};

const deserializeFromWire = <T>(object: T): T => {
    if (object === null || object === undefined) return object;

    if (isTagged(object)) {
        if (object.__gwType === "uint8array") {
            const binary = atob(object.data);
            const bytes = new Uint8Array(binary.length);

            for (let i = 0; i < binary.length; i += 1) {
                bytes[i] = binary.codePointAt(i) ?? 0;
            }

            return bytes as unknown as T;
        }

        if (object.__gwType === "date") {
            return new Date(object.iso) as unknown as T;
        }

        if (object.__gwType === "url") {
            return new URL(object.href) as unknown as T;
        }
    }

    if (Array.isArray(object)) {
        return object.map((item) => deserializeFromWire(item)) as unknown as T;
    }

    if (typeof object === "object") {
        const result: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
            result[key] = deserializeFromWire(value);
        }

        return result as T;
    }

    return object;
};

// ── GatewayLanguageModel ─────────────────────────────────────────────────────

export class GatewayLanguageModel implements LanguageModelV3 {
    readonly specificationVersion = "v3" as const;

    readonly provider: string;

    readonly modelId: string;

    // Empty supportedUrls means the SDK may download URL-referenced content before
    // sending it. This is acceptable: the gateway receives the actual data rather
    // than URLs it can't access (provider keys live on gateway, not on the backend).
    readonly supportedUrls: Record<string, RegExp[]> = {};

    private readonly config: GatewayLanguageModelConfig;

    /**
     * Stable per-instance traceparent. All doGenerate/doStream calls forward
     * this so the gateway groups them into one distributed trace.
     */
    private readonly traceparent: string;

    constructor(config: GatewayLanguageModelConfig) {
        this.config = config;
        this.provider = `gateway/${config.provider}`;
        this.modelId = config.modelId;
        this.traceparent = config.traceparent ?? generateTraceparent();
    }

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
        const requestId = `gen-${this.config.threadId ?? "unknown"}-${crypto.randomUUID()}`;

        const body = {
            action: "generate" as const,
            callOptions: serializeForWire(options),
            modelApiId: this.config.modelApiId,
            modelId: this.config.modelId,
            orgId: this.config.orgId,
            provider: this.config.provider,
            providerApiKey: this.config.providerApiKey,
            requestId,
            threadId: this.config.threadId,
            userId: this.config.userId ?? "system",
            ...(this.config.modelFilterRules && { modelFilterRules: this.config.modelFilterRules }),
            ...(this.config.customProvider && { customProvider: this.config.customProvider }),
        };

        const response = await this.postToGateway("/internal/model/proxy", body, options.abortSignal);

        if (!response.ok) {
            await this.throwStructuredError(response);
        }

        const result = deserializeFromWire(await response.json()) as LanguageModelV3GenerateResult;
        const costHeader = response.headers.get(GATEWAY_COST_HEADER);

        // An absent header (older gateway) must not read as `Number(null) === 0`.
        if (costHeader === null) {
            return result;
        }

        return withGatewayCost(
            result,
            { cost: { microdollars: Number(costHeader), pricingAvailable: response.headers.get(GATEWAY_PRICING_AVAILABLE_HEADER) !== "false" } },
            Boolean(this.config.providerApiKey),
        );
    }

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
        const requestId = `stream-${this.config.threadId ?? "unknown"}-${crypto.randomUUID()}`;

        const body = {
            action: "stream" as const,
            callOptions: serializeForWire(options),
            modelApiId: this.config.modelApiId,
            modelId: this.config.modelId,
            orgId: this.config.orgId,
            provider: this.config.provider,
            providerApiKey: this.config.providerApiKey,
            requestId,
            threadId: this.config.threadId,
            userId: this.config.userId ?? "system",
            ...(this.config.modelFilterRules && { modelFilterRules: this.config.modelFilterRules }),
            ...(this.config.customProvider && { customProvider: this.config.customProvider }),
        };

        const response = await this.postToGateway("/internal/model/proxy", body, options.abortSignal);

        if (!response.ok) {
            await this.throwStructuredError(response);
        }

        if (!response.body) {
            throw new Error("Gateway model proxy returned no body for stream");
        }

        // Convert SSE response into a ReadableStream<LanguageModelV3StreamPart>
        const sseReader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // The gateway sends its cost event AFTER the provider's `finish` part, so
        // `finish` is held back until the cost can be folded into its
        // `providerMetadata` — which the agent persists on the step's message.
        let heldFinish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined;
        const isByok = Boolean(this.config.providerApiKey);

        const stream = new ReadableStream<LanguageModelV3StreamPart>({
            cancel() {
                sseReader.cancel();
            },
            async pull(controller) {
                while (true) {
                    const { done, value } = await sseReader.read();

                    if (done) {
                        if (heldFinish) {
                            controller.enqueue(heldFinish);
                            heldFinish = undefined;
                        }

                        controller.close();

                        return;
                    }

                    buffer += decoder.decode(value, { stream: true });

                    // Parse SSE lines (double newline delimited)
                    const chunks = buffer.split("\n\n");

                    buffer = chunks.pop() ?? "";

                    for (const chunk of chunks) {
                        if (!chunk.startsWith("data: ")) continue;

                        try {
                            const parsed = JSON.parse(chunk.slice(6));

                            if (parsed.type === "gateway-metadata") {
                                if (heldFinish) {
                                    controller.enqueue(withGatewayCost(heldFinish, parsed, isByok));
                                    heldFinish = undefined;
                                }

                                continue;
                            }

                            // Gateway sends error events when the provider stream fails
                            if (parsed.type === "error") {
                                controller.error(new Error(parsed.error ?? "Unknown stream error from gateway"));

                                return;
                            }

                            // Deserialize and emit as LanguageModelV3StreamPart
                            const streamPart = deserializeFromWire(parsed) as LanguageModelV3StreamPart;

                            if (streamPart.type === "finish") {
                                heldFinish = streamPart;
                                continue;
                            }

                            controller.enqueue(streamPart);
                        } catch {
                            // Skip malformed SSE lines
                        }
                    }
                }
            },
        });

        return { stream };
    }

    // ── Internal helpers ────────────────────────────────────────────────

    /**
     * Parse gateway error response and throw with structured info preserved.
     * AI SDK callers (e.g. retry logic) inspect error properties like `statusCode`.
     */
    private async throwStructuredError(response: Response): Promise<never> {
        let message = `Gateway model proxy failed (${response.status})`;

        try {
            // `Response.json()` is `Promise<unknown>` — this whole block reads a
            // shape off an error body, so it declares the one it reads.
            const body = (await response.json()) as { error?: { message?: string } };

            message = body?.error?.message ? `${message}: ${body.error.message}` : `${message}: ${JSON.stringify(body)}`;
        } catch {
            const text = await response.text().catch(() => "");

            if (text) message += `: ${text}`;
        }

        const error = new Error(message);

        // Attach status code so AI SDK retry/error handlers can inspect it
        (error as Error & { statusCode: number }).statusCode = response.status;
        throw error;
    }

    private async postToGateway(path: string, body: unknown, abortSignal?: AbortSignal): Promise<Response> {
        // No deadline here on purpose: `doStream` reads this response as a stream,
        // which a whole-request timeout would truncate. A service binding streams
        // the body through unchanged.
        return await this.config.gateway(`${SERVICE_ORIGIN.llmGateway}${path}`, {
            body: JSON.stringify(body),
            headers: {
                "Content-Type": "application/json",
                traceparent: this.traceparent,
            },
            method: "POST",
            signal: abortSignal,
        });
    }
}

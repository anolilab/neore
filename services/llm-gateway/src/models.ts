/**
 * Gateway model catalog — public API.
 *
 * Combines the auto-generated model catalog (all text models from packages/ai)
 * with routing-specific model candidates that may use direct providers or
 * reference models not yet in the registry.
 *
 * The generated file is produced by:
 *   node tools/generate-gateway-models.mjs
 */

import type { GatewayModelDefinition } from "./models.generated.js";
import { GATEWAY_MODELS as CATALOG, MODEL_MAP as CATALOG_MAP } from "./models.generated.js";
import type { ModelCandidate } from "./routing/selector.js";

/**
 * Full model catalog — rich metadata for the /v1/models endpoint and frontend picker.
 */
export const GATEWAY_MODEL_CATALOG: GatewayModelDefinition[] = CATALOG;

/**
 * Catalog lookup by model ID.
 */
export const GATEWAY_MODEL_CATALOG_MAP: ReadonlyMap<string, GatewayModelDefinition> = CATALOG_MAP;

// ── Routing-specific candidates ──────────────────────────────────────────────
// These models are used by TIER_MODEL_POOLS for auto-routing. They may use
// direct providers (google, groq, xai) instead of OpenRouter for cost and
// latency benefits, or reference models not yet in the AI package registry.
//
// When TIER_MODEL_POOLS is updated, this list should be updated in tandem.

const ROUTING_CANDIDATES: ModelCandidate[] = [
    {
        contextWindow: 1_000_000,
        costPerMillionInput: 0.15,
        costPerMillionOutput: 0.6,
        modelApiId: "gemini-2.5-flash",
        modelId: "gemini-2.5-flash",
        provider: "google",
        regions: ["US", "EU"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 128_000,
        costPerMillionInput: 0.15,
        costPerMillionOutput: 0.6,
        modelApiId: "openai/gpt-4o-mini",
        modelId: "gpt-4o-mini",
        provider: "openrouter",
        regions: ["US"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 128_000,
        costPerMillionInput: 2.5,
        costPerMillionOutput: 10,
        modelApiId: "openai/gpt-4o",
        modelId: "gpt-4o",
        provider: "openrouter",
        regions: ["US"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 1_000_000,
        costPerMillionInput: 1.25,
        costPerMillionOutput: 10,
        modelApiId: "gemini-2.5-pro",
        modelId: "gemini-2.5-pro",
        provider: "google",
        regions: ["US", "EU"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 200_000,
        costPerMillionInput: 3,
        costPerMillionOutput: 15,
        modelApiId: "anthropic/claude-sonnet-4",
        modelId: "claude-sonnet-4",
        provider: "openrouter",
        regions: ["US", "EU"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 1_047_576,
        costPerMillionInput: 2,
        costPerMillionOutput: 8,
        modelApiId: "openai/gpt-4.1",
        modelId: "gpt-4.1",
        provider: "openrouter",
        regions: ["US"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 200_000,
        costPerMillionInput: 15,
        costPerMillionOutput: 75,
        modelApiId: "anthropic/claude-opus-4",
        modelId: "claude-opus-4",
        provider: "openrouter",
        regions: ["US", "EU"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 200_000,
        costPerMillionInput: 10,
        costPerMillionOutput: 40,
        modelApiId: "openai/o3",
        modelId: "o3",
        provider: "openrouter",
        regions: ["US"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.11,
        costPerMillionOutput: 0.34,
        modelApiId: "meta-llama/llama-4-scout-17b-16e-instruct",
        modelId: "llama-4-scout",
        provider: "groq",
        regions: ["US"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 3,
        costPerMillionOutput: 15,
        modelApiId: "grok-3",
        modelId: "grok-3",
        provider: "xai",
        regions: ["US"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    // Content-policy fallback: permissive open-source model via OpenRouter
    {
        contextWindow: 128_000,
        costPerMillionInput: 0.13,
        costPerMillionOutput: 0.13,
        modelApiId: "mistralai/mistral-nemo",
        modelId: "mistral-nemo",
        provider: "openrouter",
        regions: ["EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    // ── Cloudflare Workers AI models ──────────────────────────────────
    // Prices from https://developers.cloudflare.com/workers-ai/platform/pricing/
    // Cheapest-first: models that beat or match other providers on cost.
    {
        contextWindow: 128_000,
        costPerMillionInput: 0.017,
        costPerMillionOutput: 0.112,
        modelApiId: "@cf/ibm-granite/granite-4.0-h-micro",
        modelId: "cf-granite-4.0-micro",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.051,
        costPerMillionOutput: 0.335,
        modelApiId: "@cf/qwen/qwen3-30b-a3b-fp8",
        modelId: "cf-qwen3-30b-a3b",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.06,
        costPerMillionOutput: 0.4,
        modelApiId: "@cf/zai-org/glm-4.7-flash",
        modelId: "cf-glm-4.7-flash",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.2,
        costPerMillionOutput: 0.3,
        modelApiId: "@cf/openai/gpt-oss-20b",
        modelId: "cf-gpt-oss-20b",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.27,
        costPerMillionOutput: 0.85,
        modelApiId: "@cf/meta/llama-4-scout-17b-16e-instruct",
        modelId: "cf-llama-4-scout",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.293,
        costPerMillionOutput: 2.253,
        modelApiId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        modelId: "cf-llama-3.3-70b",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 128_000,
        costPerMillionInput: 0.345,
        costPerMillionOutput: 0.556,
        modelApiId: "@cf/google/gemma-3-12b-it",
        modelId: "cf-gemma-3-12b",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: false,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.35,
        costPerMillionOutput: 0.75,
        modelApiId: "@cf/openai/gpt-oss-120b",
        modelId: "cf-gpt-oss-120b",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 128_000,
        costPerMillionInput: 0.351,
        costPerMillionOutput: 0.555,
        modelApiId: "@cf/mistralai/mistral-small-3.1-24b-instruct",
        modelId: "cf-mistral-small-3.1",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: true,
        supportsTools: true,
    },
    {
        contextWindow: 131_072,
        costPerMillionInput: 0.5,
        costPerMillionOutput: 1.5,
        modelApiId: "@cf/nvidia/nemotron-3-120b-a12b",
        modelId: "cf-nemotron-3-120b",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: false,
        supportsTools: true,
    },
    {
        contextWindow: 256_000,
        costPerMillionInput: 0.6,
        costPerMillionOutput: 3,
        modelApiId: "@cf/moonshotai/kimi-k2.5",
        modelId: "cf-kimi-k2.5",
        provider: "cloudflare",
        regions: ["US", "EU"],
        supportsMultimodal: true,
        supportsTools: true,
    },
];

/** Convert a GatewayModelDefinition to a ModelCandidate with default cost estimates. */
const toCandidate = (definition: GatewayModelDefinition): ModelCandidate => {
    return {
        contextWindow: 128_000,
        costPerMillionInput: 1,
        costPerMillionOutput: 4,
        modelApiId: definition.modelApiId,
        modelId: definition.id,
        provider: definition.provider,
        regions: definition.regions,
        supportsMultimodal: definition.supportsMultimodal,
        // Added by the confidence-based routing work: the tier assigner needs to
        // know whether a candidate can reason before it can prefer one.
        supportsReasoning: definition.filterCapabilities?.includes("reasoning") ?? false,
        supportsTools: definition.supportsTools,
    };
};

/**
 * All model candidates for routing — includes both routing-specific models
 * (with accurate cost/context data) and all catalog models (with defaults).
 *
 * Routing-specific models take precedence (they're first in the array and
 * have the same modelId that TIER_MODEL_POOLS references).
 */
export const GATEWAY_MODELS: ModelCandidate[] = [
    ...ROUTING_CANDIDATES,
    // Add text catalog models that aren't already represented by routing candidates
    ...CATALOG.filter((definition) => definition.mode === "text" && ROUTING_CANDIDATES.every((rc) => rc.modelId !== definition.id)).map((definition) =>
        toCandidate(definition),
    ),
];

/**
 * Map from model ID → ModelCandidate.
 * Includes both routing-specific IDs (e.g. "gemini-2.5-flash") and
 * registry IDs (e.g. "google/gemini-2.5-flash").
 */
export const MODEL_MAP = new Map<string, ModelCandidate>(GATEWAY_MODELS.map((m) => [m.modelId, m]));

export { type GatewayModelDefinition, type ModelMode, MODELS_VERSION } from "./models.generated.js";

/**
 * Provider model factory.
 *
 * Creates AI SDK language model instances for each supported provider.
 * The gateway has its own provider SDK dependencies, independent of `@neore/ai`.
 */
import type { CustomProviderFormat, NativeProviderFormat } from "@neore/ai/gateway";
import {
    AZURE_DEFAULT_API_VERSION,
    bedrockRuntimeUrl,
    isAwsRegion,
    isAzureApiVersion,
    isDatedAzureApiVersion,
    isNativeProviderFormat,
    NATIVE_PROVIDER_BASE_URLS,
    parseAzureOpenAIEndpoint,
    toAnthropicApiBase,
} from "@neore/ai/gateway";
import type { LanguageModel } from "ai";

import type { AppEnv } from "../env.js";
import { GatewayError } from "../lib/errors.js";
import { validateWebhookUrl } from "../lib/webhook-delivery.js";
import type { ModelFilterRules } from "../routing/filters.js";
import { createMockLanguageModel, isMockLlmEnabled, MOCK_PROVIDER } from "./mock-model.js";

/** Trailing slash on a custom provider base URL, stripped before use. */
const TRAILING_SLASH = /\/$/;

/** Options for creating a Cloudflare Workers AI provider instance. */
export interface CloudflareProviderOptions {
    /** Cloudflare account ID (REST API fallback when AI binding is unavailable) */
    accountId?: string;
    /** Native Cloudflare AI binding (preferred — best performance, no API key needed) */
    aiBinding?: Ai;
}

/**
 * User-defined custom provider — points at any OpenAI-compatible (or Anthropic-
 * compatible) endpoint. Lets users plug in self-hosted vLLM, Ollama-on-LAN
 * (via tunnel), Together.ai, Fireworks, OpenAI-compatible enterprise gateways,
 * etc., without touching gateway code.
 */
export interface CustomProviderConfig {
    /** Bedrock only: IAM access key id; `apiKey` is then its secret access key (SigV4) rather than a Bedrock API key. */
    accessKeyId?: string;
    /** API key sent to the upstream endpoint. */
    apiKey: string;
    /** Azure only: `v1` (default), `preview`, or a dated version such as `2024-10-21`. */
    apiVersion?: string;
    /** Base URL of the OpenAI/Anthropic-compatible endpoint. Trailing slash is OK. */
    baseUrl: string;
    /** Wire format. `openai-chat` is the OpenAI Chat Completions shape. */
    format: CustomProviderFormat;
    /** Optional extra headers (e.g. `OpenAI-Organization`) merged onto every request. */
    headers?: Record<string, string>;
    /** Stable identifier the gateway uses to address the provider in requests. */
    id: string;
    /** Bedrock only: the AWS region the runtime host is derived from. */
    region?: string;
}

/** OpenRouter's native `provider` routing object — the keys this gateway sets. */
type OpenRouterProviderPreferences = {
    data_collection?: "deny";
    ignore?: string[];
    only?: string[];
    zdr?: boolean;
};

/**
 * Build OpenRouter provider preferences from model filter rules.
 * Maps our internal filter rules to OpenRouter's native `provider` object.
 */
export const buildOpenRouterProviderPreferences = (rules: ModelFilterRules | undefined): OpenRouterProviderPreferences | undefined => {
    if (!rules) return undefined;

    const prefs: OpenRouterProviderPreferences = {};

    // Map blockedProviders to OpenRouter's `ignore`
    if (rules.blockedProviders && rules.blockedProviders.length > 0) {
        prefs.ignore = rules.blockedProviders;
    }

    // Map allowedProviders to OpenRouter's `only`
    if (rules.allowedProviders && rules.allowedProviders.length > 0) {
        prefs.only = rules.allowedProviders;
    }

    // Map privacy settings
    if (rules.denyDataCollection) {
        prefs.data_collection = "deny";
    }

    if (rules.requireZDR) {
        prefs.zdr = true;
    }

    return Object.keys(prefs).length > 0 ? prefs : undefined;
};

/**
 * A provider's NATIVE API on the user's own key (`google`, `azure`, `bedrock`,
 * `mistral`). The backend validated the row when it was saved; this re-checks
 * the one thing that decides where the key goes — the host — because a key for
 * these providers must never reach any other server:
 *
 * - Google and Mistral ignore `baseUrl` and use their SDK default.
 * - Azure accepts only an Azure OpenAI resource origin.
 * - Bedrock derives its host from a validated region.
 *
 * Each SDK is imported on demand, so a gateway that never serves one does not
 * pay its startup cost.
 */
const createNativeProviderModel = async (format: NativeProviderFormat, modelApiId: string, config: CustomProviderConfig): Promise<LanguageModel> => {
    const notConfigured = (message: string) => new GatewayError("PROVIDER_NOT_CONFIGURED", message, { provider: "custom" });

    if (!config.apiKey) {
        throw notConfigured(`A ${format} endpoint needs its API key`);
    }

    switch (format) {
        case "azure": {
            const endpoint = parseAzureOpenAIEndpoint(config.baseUrl);

            if ("error" in endpoint) {
                throw notConfigured(`customProvider.baseUrl rejected: ${endpoint.error}`);
            }

            const apiVersion = config.apiVersion ?? AZURE_DEFAULT_API_VERSION;

            if (!isAzureApiVersion(apiVersion)) {
                throw notConfigured(`Invalid Azure api-version: ${apiVersion}`);
            }

            const { createAzure } = await import("@ai-sdk/azure");

            // A dated api-version is the classic surface, which addresses the
            // model by deployment URL; `v1`/`preview` take the deployment name
            // as the request's `model`.
            return createAzure({
                apiKey: config.apiKey,
                apiVersion,
                baseURL: `${endpoint.url}/openai`,
                fetch: (input, init) => fetch(input, { ...init, redirect: "manual" }),
                useDeploymentBasedUrls: isDatedAzureApiVersion(apiVersion),
            }).chat(modelApiId);
        }
        case "bedrock": {
            const region = config.region ?? "";

            if (!isAwsRegion(region)) {
                throw notConfigured(`Invalid AWS region: ${region || "(none)"}`);
            }

            const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
            // With an access key id the stored secret is its secret access key
            // (SigV4); without one it is a Bedrock API key (bearer). Both are
            // passed explicitly so the SDK never falls back to ambient AWS env.
            const credentials = config.accessKeyId ? { accessKeyId: config.accessKeyId, secretAccessKey: config.apiKey } : { apiKey: config.apiKey };

            return createAmazonBedrock({ ...credentials, baseURL: bedrockRuntimeUrl(region), region })(modelApiId);
        }
        case "google": {
            const { createGoogleGenerativeAI } = await import("@ai-sdk/google");

            return createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: NATIVE_PROVIDER_BASE_URLS.google })(modelApiId);
        }
        case "mistral": {
            const { createMistral } = await import("@ai-sdk/mistral");

            return createMistral({ apiKey: config.apiKey, baseURL: NATIVE_PROVIDER_BASE_URLS.mistral })(modelApiId);
        }
        default: {
            throw notConfigured(`Unsupported customProvider.format: ${format as string}`);
        }
    }
};

/**
 * Create an AI SDK language model for the given provider + model ID.
 * @param provider Provider slug (e.g. `"openai"`, `"cloudflare"`, `"custom"`).
 * @param modelApiId Provider-side model identifier.
 * @param apiKey API key for the provider.
 * @param filterRules Optional OpenRouter-style provider routing preferences.
 * @param cloudflareOptions — Required when `provider` is `"cloudflare"`.
 * Pass `{ aiBinding: env.AI, accountId: env.CLOUDFLARE_ACCOUNT_ID }`.
 * @param customProvider — Required when `provider === "custom"`. Specifies the
 * user-supplied baseUrl/apiKey/format for an OpenAI/Anthropic-compatible
 * endpoint.
 */
export const createProviderModel = async (
    provider: string,
    modelApiId: string,
    apiKey: string,
    filterRules?: ModelFilterRules,
    cloudflareOptions?: CloudflareProviderOptions,
    customProvider?: CustomProviderConfig,
): Promise<LanguageModel> => {
    switch (provider) {
        case "custom": {
            if (!customProvider) {
                throw new GatewayError("PROVIDER_NOT_CONFIGURED", "`provider: custom` requires a customProvider config (baseUrl, apiKey, format)", {
                    provider: "custom",
                });
            }

            if (isNativeProviderFormat(customProvider.format)) {
                return await createNativeProviderModel(customProvider.format, modelApiId, customProvider);
            }

            const baseUrl = customProvider.baseUrl.replace(TRAILING_SLASH, "");

            // The base URL is user-supplied and fetched from here, so it gets the
            // same SSRF guard as outbound webhooks: https only, no private,
            // loopback, link-local or IPv4-mapped hosts.
            const urlError = validateWebhookUrl(baseUrl);

            if (urlError) {
                throw new GatewayError("PROVIDER_NOT_CONFIGURED", `customProvider.baseUrl rejected: ${urlError}`, { provider: "custom" });
            }

            switch (customProvider.format) {
                case "anthropic": {
                    const { createAnthropic } = await import("@ai-sdk/anthropic");
                    const anthropic = createAnthropic({
                        // `createAnthropic` throws on a missing key; keyless proxies
                        // ignore the header, so send a placeholder rather than none.
                        apiKey: customProvider.apiKey || "no-key",
                        baseURL: toAnthropicApiBase(baseUrl),
                        // A redirect could bounce the request onto a host the guard
                        // above would have refused, so never follow one.
                        fetch: (input, init) => fetch(input, { ...init, redirect: "manual" }),
                        ...(customProvider.headers && { headers: customProvider.headers }),
                    });

                    return anthropic.messages(modelApiId);
                }
                case "openai-chat": {
                    const { createOpenAI } = await import("@ai-sdk/openai");
                    const openai = createOpenAI({
                        // Local servers (Ollama, LM Studio) ignore the key but some
                        // proxies reject a bare `Bearer ` header, so never send it empty.
                        apiKey: customProvider.apiKey || "no-key",
                        baseURL: baseUrl,
                        fetch: (input, init) => fetch(input, { ...init, redirect: "manual" }),
                        ...(customProvider.headers && { headers: customProvider.headers }),
                    });

                    // `openai(id)` is the Responses API, which OpenAI-compatible
                    // servers (vLLM, LM Studio, most proxies) do not implement.
                    return openai.chat(modelApiId);
                }
                default: {
                    throw new GatewayError("PROVIDER_NOT_CONFIGURED", `Unsupported customProvider.format: ${(customProvider as { format: string }).format}`, {
                        provider: "custom",
                    });
                }
            }
        }
        case "openrouter": {
            const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
            const providerPrefs = buildOpenRouterProviderPreferences(filterRules);

            // If EU-only region is requested, use the EU endpoint
            const isEUOnly = filterRules?.allowedRegions && filterRules.allowedRegions.length === 1 && filterRules.allowedRegions[0] === "EU";
            const baseURL = isEUOnly ? "https://eu.openrouter.ai/api/v1" : undefined;

            const openrouter = createOpenRouter({
                apiKey,
                ...(baseURL && { baseURL }),
            });
            const model = openrouter(modelApiId, providerPrefs ? { provider: providerPrefs } : undefined);

            return model;
        }
        case "google": {
            const { createGoogleGenerativeAI } = await import("@ai-sdk/google");

            return createGoogleGenerativeAI({ apiKey })(modelApiId);
        }
        case "groq": {
            const { createGroq } = await import("@ai-sdk/groq");

            return createGroq({ apiKey })(modelApiId);
        }
        case "openai": {
            const { createOpenAI } = await import("@ai-sdk/openai");

            return createOpenAI({ apiKey })(modelApiId);
        }
        case "requesty": {
            const { createRequesty } = await import("@requesty/ai-sdk");

            return createRequesty({ apiKey })(modelApiId);
        }
        case "xai": {
            const { createXai } = await import("@ai-sdk/xai");

            return createXai({ apiKey })(modelApiId);
        }
        case "cloudflare": {
            const { createWorkersAI } = await import("workers-ai-provider");

            // Prefer native AI binding (best performance, runs on same Cloudflare network)
            if (cloudflareOptions?.aiBinding) {
                return createWorkersAI({ binding: cloudflareOptions.aiBinding })(modelApiId);
            }

            // Fall back to REST API with account credentials
            if (apiKey && cloudflareOptions?.accountId) {
                return createWorkersAI({ accountId: cloudflareOptions.accountId, apiKey })(modelApiId);
            }

            throw new GatewayError("PROVIDER_NOT_CONFIGURED", "Cloudflare provider requires either an AI binding or accountId + apiKey");
        }
        default: {
            throw new GatewayError("PROVIDER_NOT_CONFIGURED", `Unsupported provider: ${provider}`);
        }
    }
};

/**
 * The provider model, behind the `MOCK_LLM` switch: with the flag on
 * (never in production) every provider — and the explicit `mock` one — answers
 * with the deterministic mock, so dev and e2e need no provider key.
 */
export const createProviderModelForEnv = async (
    env: AppEnv,
    provider: string,
    modelApiId: string,
    apiKey: string,
    filterRules?: ModelFilterRules,
    customProvider?: CustomProviderConfig,
): Promise<LanguageModel> => {
    if (isMockLlmEnabled(env)) {
        return createMockLanguageModel(provider === MOCK_PROVIDER ? `${MOCK_PROVIDER}/${modelApiId}` : modelApiId);
    }

    return await createProviderModel(provider, modelApiId, apiKey, filterRules, resolveCloudflareOptions(env), customProvider);
};

/**
 * Resolve API key: BYOK takes priority, then platform env var.
 *
 * For the `cloudflare` provider the key is optional — the native AI binding
 * is the preferred path.  When no binding is available, the REST API needs
 * `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, resolved separately).
 */
export const resolveApiKey = (provider: string, env: AppEnv, byokKey?: string): string => {
    // Custom providers carry their own apiKey on the customProvider config and
    // don't need a top-level key. Return whatever was supplied (or empty) so
    // the call site doesn't throw before it gets to the custom branch.
    if (provider === "custom") {
        return byokKey ?? "";
    }

    if (byokKey) {
        return byokKey;
    }

    // The mock needs no key, and a missing one must not fail the call before
    // `createProviderModelForEnv` gets to swap the model.
    if (isMockLlmEnabled(env)) {
        return "mock";
    }

    // Cloudflare Workers AI: key is optional when the AI binding is available.
    // Return the env key if set, otherwise return empty string (binding mode).
    if (provider === "cloudflare") {
        return env.CLOUDFLARE_API_KEY ?? "";
    }

    const keyMap: Record<string, string | undefined> = {
        bfl: env.BFL_API_KEY,
        fal: env.FAL_API_KEY,
        google: env.GOOGLE_API_KEY,
        groq: env.GROQ_API_KEY,
        openai: env.OPENAI_API_KEY,
        openrouter: env.OPENROUTER_API_KEY,
        requesty: env.REQUESTY_API_KEY,
        xai: env.XAI_API_KEY,
    };

    const key = keyMap[provider];

    if (!key) {
        throw new GatewayError("PROVIDER_NOT_CONFIGURED", `No API key for provider: ${provider}`);
    }

    return key;
};

/**
 * Build CloudflareProviderOptions from the environment.
 * Call sites should pass this to `createProviderModel()` when provider is `"cloudflare"`.
 */
export const resolveCloudflareOptions = (env: AppEnv): CloudflareProviderOptions => {
    return {
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        aiBinding: env.AI,
    };
};

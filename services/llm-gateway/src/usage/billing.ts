import type { BillingMode, CustomProviderFormat } from "@neore/ai/gateway";
import { DEFAULT_BYOK_FEE_RATE, isNativeProviderFormat } from "@neore/ai/gateway";

// The billing contract (the modes, the default fee) is shared with the backend
// that deducts the credits; see `@neore/ai/gateway`.
export { type BillingMode, DEFAULT_BYOK_FEE_RATE } from "@neore/ai/gateway";

/**
 * Domains owned by hosted model providers. A custom row whose base URL lands on
 * one of these (the domain itself or any subdomain) is the user's own key for a
 * provider we could have served on ours, whatever wire format it speaks —
 * OpenAI-compatible Gemini, Groq through `openai-chat`, Anthropic through
 * `anthropic` — so it is BYOK, not a free custom endpoint.
 *
 * Only provider-OWNED domains go here, where no user can host their own
 * endpoint. Shared clouds are matched by pattern below instead.
 */
const HOSTED_PROVIDER_DOMAINS: ReadonlyArray<string> = [
    "ai21.com",
    "anthropic.com",
    "cerebras.ai",
    "cohere.ai",
    "cohere.com",
    "deepinfra.com",
    "deepseek.com",
    "fireworks.ai",
    "groq.com",
    "hyperbolic.xyz",
    "mistral.ai",
    "moonshot.ai",
    "moonshot.cn",
    "novita.ai",
    "openai.com",
    "openrouter.ai",
    "perplexity.ai",
    "sambanova.ai",
    "together.ai",
    "together.xyz",
    "x.ai",
];

/**
 * Hosted-provider hosts on shared cloud domains, where a suffix match would
 * also catch whatever a user runs there (`*.amazonaws.com`, `*.azure.com`).
 */
const HOSTED_PROVIDER_HOST_PATTERNS: ReadonlyArray<RegExp> = [
    // Gemini API (native and its OpenAI-compatible path) and Vertex AI.
    /^generativelanguage\.googleapis\.com$/u,
    /^(?:[a-z\d-]+-)?aiplatform\.googleapis\.com$/u,
    // Azure OpenAI / AI Foundry resources.
    /^[a-z\d-]+\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/u,
    // Bedrock, incl. the runtime and FIPS endpoints.
    /^bedrock(?:-runtime|-agent-runtime)?(?:-fips)?\.[a-z\d-]+\.amazonaws\.com$/u,
    // Workers AI's OpenAI-compatible endpoint.
    /^api\.cloudflare\.com$/u,
];

/**
 * Whether `baseUrl` points at a hosted model provider. Decided on the parsed
 * HOSTNAME only — userinfo (`https://api.openai.com@evil.test`) and the port are
 * not part of it — so a look-alike host (`api.openai.com.evil.test`) stays
 * custom. An unparseable URL is not a provider.
 */
export const isHostedProviderUrl = (baseUrl: string): boolean => {
    let host: string;

    try {
        host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
        return false;
    }

    // `api.openai.com.` resolves to the same host.
    if (host.endsWith(".")) {
        host = host.slice(0, -1);
    }

    if (HOSTED_PROVIDER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return true;
    }

    return HOSTED_PROVIDER_HOST_PATTERNS.some((pattern) => pattern.test(host));
};

export const resolveBillingMode = ({
    customBaseUrl,
    customFormat,
    isCustom,
    providerApiKey,
}: {
    customBaseUrl?: string;
    customFormat?: CustomProviderFormat;
    isCustom: boolean;
    providerApiKey?: string;
}): BillingMode => {
    if (isCustom) {
        // A provider-native row (Gemini, Azure OpenAI, Bedrock, Mistral) — or a
        // compatible-format row pointed at a hosted provider — is the user's own
        // key for a provider we could have served on ours: BYOK, and pays the
        // fee. Only a self-hosted or otherwise unknown endpoint is free.
        if (customFormat && isNativeProviderFormat(customFormat)) {
            return "byok";
        }

        return customBaseUrl !== undefined && isHostedProviderUrl(customBaseUrl) ? "byok" : "custom";
    }

    // `resolveApiKey` gives a supplied BYOK key priority over the platform key,
    // so a non-empty one here is exactly the key the call ran on.
    return providerApiKey ? "byok" : "platform";
};

/**
 * Parse `BYOK_FEE_RATE`: a fraction of model cost in 0..1. Unset means the
 * default; anything unparseable or out of range also falls back to the default,
 * and is logged, since a typo here silently changes what every BYOK user pays.
 */
export const resolveByokFeeRate = (raw: string | undefined): number => {
    if (raw === undefined || raw.trim() === "") {
        return DEFAULT_BYOK_FEE_RATE;
    }

    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        console.error(`[billing] Invalid BYOK_FEE_RATE ${JSON.stringify(raw)} — expected a number in 0..1; using ${DEFAULT_BYOK_FEE_RATE}`);

        return DEFAULT_BYOK_FEE_RATE;
    }

    return parsed;
};

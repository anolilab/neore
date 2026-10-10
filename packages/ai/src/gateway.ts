/**
 * The contract between the backend, the LLM gateway and the web app.
 *
 * Lives here because `@neore/ai` is the one package all three already depend
 * on. Everything in this module is plain data and pure functions, so importing
 * it pulls no provider SDK into any of them.
 */

/**
 * How a proxied model call is billed, decided by the gateway where the key is resolved.
 *
 * - `platform`: the gateway's own provider key paid, so the backend deducts the full cost.
 * - `byok`: the user's own key paid; the backend deducts only the platform fee
 *   (`BYOK_FEE_RATE` of the cost).
 * - `custom`: a user-configured custom endpoint; never charged.
 *
 * The mode is an explicit flag carried on the usage report. It is never
 * reconstructed from a key value downstream.
 */
export const BILLING_MODES = ["platform", "byok", "custom"] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

export const isBillingMode = (value: unknown): value is BillingMode => (BILLING_MODES as ReadonlyArray<unknown>).includes(value);

/** The BYOK platform fee, as a fraction of model cost, when none is configured or reported. */
export const DEFAULT_BYOK_FEE_RATE = 0.1;

/** 1 credit = 1,000 microdollars. */
export const MICRODOLLARS_PER_CREDIT = 1000;

/**
 * Wire formats a user-configured endpoint can speak.
 *
 * - `openai-chat` / `anthropic`: any compatible server at a user-chosen URL
 *   (vLLM, LM Studio, Ollama, most proxies). Billed as `custom` — never charged.
 * - `google` / `azure` / `bedrock` / `mistral`: a provider's NATIVE API on the
 *   user's own key for that provider ({@link NATIVE_PROVIDER_FORMATS}). The URL
 *   is pinned to the provider's own hosts, and the call is billed as `byok`.
 */
export const CUSTOM_PROVIDER_FORMATS = ["openai-chat", "anthropic", "google", "azure", "bedrock", "mistral"] as const;

export type CustomProviderFormat = (typeof CUSTOM_PROVIDER_FORMATS)[number];

/** The provider-native formats: the user's own key for a provider we call through its own SDK. */
export const NATIVE_PROVIDER_FORMATS = ["google", "azure", "bedrock", "mistral"] as const;

export type NativeProviderFormat = (typeof NATIVE_PROVIDER_FORMATS)[number];

export const isNativeProviderFormat = (value: unknown): value is NativeProviderFormat => (NATIVE_PROVIDER_FORMATS as ReadonlyArray<unknown>).includes(value);

/** The fixed API base of the providers whose host is not the user's to choose. */
export const NATIVE_PROVIDER_BASE_URLS = {
    google: "https://generativelanguage.googleapis.com/v1beta",
    mistral: "https://api.mistral.ai/v1",
} as const satisfies Partial<Record<NativeProviderFormat, string>>;

/** `us-east-1`, `eu-central-2`, `us-gov-west-1`, `ap-southeast-4` … */
const AWS_REGION_RE = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;

export const isAwsRegion = (value: string): boolean => AWS_REGION_RE.test(value);

/** The Bedrock runtime endpoint of a region — the one host a Bedrock key is sent to. */
export const bedrockRuntimeUrl = (region: string): string => `https://bedrock-runtime.${region}.amazonaws.com`;

/**
 * Hosts an Azure OpenAI resource is served from: classic `*.openai.azure.com`,
 * the AI Services `*.cognitiveservices.azure.com` and Foundry
 * `*.services.ai.azure.com`. A key is only ever sent to one of these, so a
 * stored Azure key cannot be pointed at an arbitrary server.
 */
const AZURE_OPENAI_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/;

/**
 * Normalise an Azure OpenAI endpoint to its origin (`https://&lt;resource>.openai.azure.com`).
 * Accepts the endpoint as the Azure portal shows it, with or without a trailing
 * `/` or `/openai…` path.
 */
export const parseAzureOpenAIEndpoint = (raw: string): { error: string } | { url: string } => {
    let parsed: URL;

    try {
        parsed = new URL(raw.trim());
    } catch {
        return { error: "Invalid URL" };
    }

    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
        return { error: "Use the resource endpoint as the Azure portal shows it, e.g. https://my-resource.openai.azure.com" };
    }

    const host = parsed.hostname.toLowerCase();

    if (!AZURE_OPENAI_HOST_RE.test(host)) {
        return { error: "Not an Azure OpenAI endpoint — expected https://<resource>.openai.azure.com (or .cognitiveservices.azure.com)" };
    }

    return { url: `https://${host}` };
};

/** `2024-10-21`, `2025-04-01-preview`, or the date-less `v1` / `preview` of the v1 API. */
const AZURE_API_VERSION_RE = /^(?:v1|preview|\d{4}-\d{2}-\d{2}(?:-preview)?)$/;
const DATED_AZURE_API_VERSION_RE = /^\d{4}-/;

export const isAzureApiVersion = (value: string): boolean => AZURE_API_VERSION_RE.test(value);

/** The v1 API needs no dated version; a dated one addresses the model by deployment URL. */
export const AZURE_DEFAULT_API_VERSION = "v1";

export const isDatedAzureApiVersion = (value: string): boolean => DATED_AZURE_API_VERSION_RE.test(value);

/** An AWS access key id — long-term (`AKIA…`); temporary `ASIA…` ids need a session token, which is not stored. */
const AWS_ACCESS_KEY_ID_RE = /^AKIA[A-Z0-9]{16}$/;

export const isAwsAccessKeyId = (value: string): boolean => AWS_ACCESS_KEY_ID_RE.test(value);

/**
 * Shape checks for a key before it is stored — they catch a key pasted into the
 * wrong provider or a truncated copy, which the provider would otherwise only
 * report as a 401 on the first chat. Deliberately loose where a provider has no
 * documented format.
 *
 * `bedrock` holds EITHER a Bedrock API key (`ABSK…` long-term,
 * `bedrock-api-key-…` short-term) OR, when `accessKeyId` is set, the secret
 * access key that goes with it.
 */
const AZURE_KEY_RE = /^[A-Z0-9]{32,128}$/i;
const AWS_SECRET_ACCESS_KEY_RE = /^[A-Z0-9/+]{40}$/i;
const BEDROCK_API_KEY_RE = /^(?:ABSK|bedrock-api-key-)[\w+/=.-]{20,}$/;
const GEMINI_KEY_RE = /^AIza[\w-]{35}$/;
const MISTRAL_KEY_RE = /^[A-Z0-9]{24,64}$/i;
const KEY_RULES: Record<NativeProviderFormat, { message: string; test: (key: string, options: { accessKeyId?: string }) => boolean }> = {
    azure: { message: "An Azure OpenAI key is 32 or 84 letters and digits (Keys and Endpoint in the Azure portal)", test: (key) => AZURE_KEY_RE.test(key) },
    bedrock: {
        message: "Expected a Bedrock API key (ABSK…) — or, with an access key id, its 40-character secret access key",
        test: (key, { accessKeyId }) => (accessKeyId ? AWS_SECRET_ACCESS_KEY_RE.test(key) : BEDROCK_API_KEY_RE.test(key)),
    },
    google: { message: "A Gemini API key starts with AIza and is 39 characters (Google AI Studio → Get API key)", test: (key) => GEMINI_KEY_RE.test(key) },
    mistral: { message: "A Mistral API key is letters and digits only (console.mistral.ai → API keys)", test: (key) => MISTRAL_KEY_RE.test(key) },
};

/** `null` when the key has the provider's shape, else a message saying what was expected. */
export const validateNativeProviderKey = (format: NativeProviderFormat, key: string, options: { accessKeyId?: string } = {}): string | null => {
    const rule = KEY_RULES[format];

    return rule.test(key.trim(), options) ? null : rule.message;
};

/**
 * The versioned API base of an Anthropic-compatible endpoint.
 *
 * Such services publish the server ROOT (the `ANTHROPIC_BASE_URL` convention,
 * e.g. `https://api.deepseek.com/anthropic`), while the API lives under `/v1`
 * (`@ai-sdk/anthropic` appends `/messages`, the models list is `/models`). A URL
 * already ending in `/v1` is taken as-is. Expects no trailing slash.
 */
export const toAnthropicApiBase = (baseUrl: string): string => (baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`);

/**
 * Web-page context the browser extension attaches to a message, as the
 * `pageContext` field of the `/v1/chat` start payload. The gateway passes the
 * body through untouched; the backend validates it against its own caps
 * (`backend/lunora/chat/lib/page-context.ts`) and the extension budgets it
 * below them (`apps/browser-extension/src/page-context/build.ts`).
 *
 * Third-party content: untrusted, never instructions.
 */
export interface PageContext {
    selection?: string;
    text?: string;
    title: string;
    url: string;
}

/**
 * Structural marker on the stored text part that carries a page into a user
 * message: `providerOptions.neore.pageContext`, surfaced to clients as the UI
 * part's `providerMetadata.neore.pageContext`. Clients render it as a chip
 * instead of the part's text, which is the page wrapped for the model.
 *
 * `excerptRanges` locate what the chip shows when expanded — the selection and
 * page text — inside the part's own text, rather than a second copy of it:
 * the whole call options, part metadata included, cross the wire to the
 * gateway on every model call. Each range spans one JSON string literal
 * (quotes included), so a client decodes it with `JSON.parse` on the slice.
 * Absent on messages stored before ranges were added.
 */
export interface PageContextMarker {
    excerptRanges?: ReadonlyArray<{ end: number; start: number }>;
    kind: "page" | "selection";
    title: string;
    url: string;
}

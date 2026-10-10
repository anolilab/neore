/**
 * Pure helpers for user-configured custom model endpoints (Ollama, LM Studio,
 * vLLM, any OpenAI-compatible server).
 *
 * Stored in `aiUserPreferences.customAIProviders[providerId]` with the same
 * `{ enabled, encryptedKey }` shape as the other BYOK keys; the procedures live
 * in `chat/custom-providers.ts`. Nothing here touches the database or the
 * network, so it is all unit-tested in `custom-providers.test.ts`.
 */
import type { CustomProviderFormat, NativeProviderFormat } from "@neore/ai/gateway";
import {
    bedrockRuntimeUrl,
    isAwsRegion,
    isNativeProviderFormat,
    NATIVE_PROVIDER_BASE_URLS,
    parseAzureOpenAIEndpoint,
    toAnthropicApiBase,
} from "@neore/ai/gateway";
import { validateLocalEndpointUrl } from "@neore/ai/models";

import { validateDomain } from "../tools/utilities";

/**
 * `local-browser` is an OpenAI-compatible server on the user's own machine
 * (Ollama, LM Studio) that the BROWSER calls — never the backend or gateway.
 * See `@neore/ai/models` `validateLocalEndpointUrl` and `chat/local-models.ts`.
 */
export type CustomProviderType = "anthropic" | "local-browser" | "openai" | NativeProviderFormat;

export const isLocalBrowserProvider = (type: CustomProviderType | undefined): type is "local-browser" => type === "local-browser";

/**
 * A provider's own API on the user's own key: Google Gemini, Azure OpenAI,
 * Amazon Bedrock, Mistral. Unlike a compatible endpoint the host is not the
 * user's to pick — it is fixed, or derived from a region / Azure resource —
 * and the calls are billed as BYOK (see the gateway's `resolveBillingMode`).
 */
export const isNativeProvider = (type: CustomProviderType | undefined): type is NativeProviderFormat => isNativeProviderFormat(type);

export interface CustomProviderModel {
    id: string;
    name?: string;
}

/** The stored row, as it sits (encrypted) in `customAIProviders`. */
export interface StoredCustomProvider {
    /** Bedrock only: IAM access key id; the encrypted key is then its secret access key. Not a secret on its own. */
    accessKeyId?: string;
    /** Azure only: `v1`, `preview` or a dated api-version. */
    apiVersion?: string;
    createdAt?: number;
    enabled: boolean;
    /** `v1:` ciphertext, or `""` when the endpoint needs no key. */
    encryptedKey: string;
    endpoint: string;
    /** Last four characters of the key, for display (keys of 12+ chars only). */
    last4?: string;
    models?: CustomProviderModel[];
    name: string;
    /** Bedrock only. */
    region?: string;
    /** Whether the endpoint's models may be sent tool definitions. Off unless the user opts in. */
    supportsTools?: boolean;
    type?: CustomProviderType;
    updatedAt?: number;
}

export const MAX_CUSTOM_PROVIDERS = 10;
export const MAX_CUSTOM_MODELS_PER_PROVIDER = 200;
export const PROBE_TIMEOUT_MS = 8000;

const TRAILING_DOT_RE = /\.$/;
const GOOGLE_MODEL_PREFIX_RE = /^models\//;
const SLUG_INVALID_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_DASH_RE = /^-|-$/g;

/** Hostnames that only ever resolve inside a private network. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/**
 * Validate a user-supplied base URL before it is stored or fetched.
 *
 * Reuses the backend SSRF guard (`validateDomain` → `isSafeUrl`: private,
 * loopback, link-local, CGNAT, IPv4-mapped IPv6 and metadata hosts) and adds
 * two rules of its own: https only, because the request carries the user's API
 * key, and no private-only DNS suffixes. The gateway re-checks the same URL
 * with its own guard before it calls it.
 *
 * Returns the normalised URL (no trailing slash, no query/hash) or an error.
 */
export const validateCustomEndpointUrl = (raw: string): { error: string } | { url: string } => {
    const trimmed = raw.trim();
    let parsed: URL;

    try {
        parsed = new URL(trimmed);
    } catch {
        return { error: "Invalid URL" };
    }

    if (parsed.protocol !== "https:") {
        return { error: "The endpoint must use https://" };
    }

    if (parsed.username || parsed.password) {
        return { error: "Put credentials in the API key field, not in the URL" };
    }

    const domainError = validateDomain(trimmed);

    if (domainError) {
        return { error: "Private, local and loopback addresses cannot be reached from the server. Expose the endpoint through a public HTTPS URL." };
    }

    const host = parsed.hostname.toLowerCase().replace(TRAILING_DOT_RE, "");

    if (!host.includes(".") || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return { error: "Private, local and loopback addresses cannot be reached from the server. Expose the endpoint through a public HTTPS URL." };
    }

    parsed.hash = "";
    parsed.search = "";

    let url = parsed.href;

    while (url.endsWith("/")) {
        url = url.slice(0, -1);
    }

    return { url };
};

/**
 * The URL rule for an endpoint kind: a `local-browser` endpoint must be
 * loopback (the browser calls it), a provider-native one is pinned to that
 * provider's hosts, and every other kind must be public HTTPS (the server
 * calls it). One entry point so no save path can pick the wrong rule.
 *
 * `region` is Bedrock's: its host is derived from it, never taken from `raw`.
 */
export const validateEndpointUrlForType = (type: CustomProviderType, raw: string, options: { region?: string } = {}): { error: string } | { url: string } => {
    switch (type) {
        case "azure": {
            return parseAzureOpenAIEndpoint(raw);
        }
        case "bedrock": {
            const region = options.region?.trim() ?? "";

            return isAwsRegion(region) ? { url: bedrockRuntimeUrl(region) } : { error: "Enter a valid AWS region, e.g. us-east-1" };
        }
        case "google":
        case "mistral": {
            return { url: NATIVE_PROVIDER_BASE_URLS[type] };
        }
        case "local-browser": {
            return validateLocalEndpointUrl(raw);
        }
        default: {
            return validateCustomEndpointUrl(raw);
        }
    }
};

/**
 * The models-list URL for a stored endpoint.
 *
 * OpenAI-compatible base URLs carry their version segment (`…/v1`) and the list
 * is `{baseUrl}/models`. Anthropic-compatible services publish the server ROOT
 * — the `ANTHROPIC_BASE_URL` convention, e.g. `https://api.deepseek.com/anthropic`
 * — and the list is `{root}/v1/models`; a base URL already ending in `/v1` is
 * accepted too — `toAnthropicApiBase`, the rule the gateway builds the provider with.
 */
export const buildModelsUrl = (type: CustomProviderType, baseUrl: string, options: { apiVersion?: string } = {}): string => {
    switch (type) {
        case "anthropic": {
            // Anthropic pages at 20 by default; 1000 is its maximum and covers any real catalog.
            return `${toAnthropicApiBase(baseUrl)}/models?limit=1000`;
        }
        case "azure": {
            // Base models, not deployments — Azure lists deployments only through
            // the management API. Used to check the endpoint and key, not to fill the list.
            return `${baseUrl}/openai/models?api-version=${encodeURIComponent(options.apiVersion && options.apiVersion !== "v1" ? options.apiVersion : "2024-10-21")}`;
        }
        case "google": {
            return `${baseUrl}/models?pageSize=1000`;
        }
        default: {
            return `${baseUrl}/models`;
        }
    }
};

/** Request headers for `GET {baseUrl}/models`, per wire format. */
export const buildModelsRequestHeaders = (type: CustomProviderType, apiKey: string | undefined): Record<string, string> => {
    const headers: Record<string, string> = { accept: "application/json" };

    if (!apiKey) {
        return type === "anthropic" ? { ...headers, "anthropic-version": "2023-06-01" } : headers;
    }

    switch (type) {
        case "anthropic": {
            return { ...headers, "anthropic-version": "2023-06-01", "x-api-key": apiKey };
        }
        case "azure": {
            return { ...headers, "api-key": apiKey };
        }
        case "google": {
            return { ...headers, "x-goog-api-key": apiKey };
        }
        default: {
            return { ...headers, authorization: `Bearer ${apiKey}` };
        }
    }
};

/**
 * Pull the model list out of a `/models` response.
 *
 * OpenAI, vLLM, LM Studio and Ollama's `/v1/models` answer `{ data: [{ id }] }`;
 * Anthropic answers `{ data: [{ id, display_name }] }`; Ollama's native
 * `/api/tags` answers `{ models: [{ name }] }` — accepted too, since pointing
 * the base URL at the server root instead of `/v1` is the commonest mistake.
 * Anything unrecognised yields `[]` rather than throwing.
 */
export const parseModelsResponse = (body: unknown): CustomProviderModel[] => {
    if (!body || typeof body !== "object") {
        return [];
    }

    const record = body as { data?: unknown; models?: unknown };
    let list: unknown[] = [];

    if (Array.isArray(record.data)) {
        list = record.data;
    } else if (Array.isArray(record.models)) {
        list = record.models;
    }

    const seen = new Set<string>();
    const out: CustomProviderModel[] = [];

    for (const entry of list) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const item = entry as { display_name?: unknown; id?: unknown; model?: unknown; name?: unknown };
        // `id` (OpenAI/Anthropic), else `model`/`name` (Ollama's /api/tags).
        const rawId = [item.id, item.model, item.name].find((value): value is string => typeof value === "string");
        const id = rawId?.trim();

        if (!id || id.length > 200 || seen.has(id)) {
            continue;
        }

        seen.add(id);

        const display = typeof item.display_name === "string" ? item.display_name.trim() : undefined;

        out.push(display && display !== id ? { id, name: display } : { id });

        if (out.length >= MAX_CUSTOM_MODELS_PER_PROVIDER) {
            break;
        }
    }

    return out.toSorted((a, b) => a.id.localeCompare(b.id));
};

/**
 * Gemini's `/models` answers `{ models: [{ name: "models/gemini-…",
 * displayName, supportedGenerationMethods }] }`: strip the `models/` prefix and
 * keep the chat models (those that `generateContent`), not embedders.
 */
export const parseGoogleModelsResponse = (body: unknown): CustomProviderModel[] => {
    const list = (body as { models?: unknown } | null)?.models;

    if (!Array.isArray(list)) {
        return [];
    }

    const chat = list.filter((entry): entry is { displayName?: unknown; name: string; supportedGenerationMethods?: unknown } => {
        const item = entry as { name?: unknown; supportedGenerationMethods?: unknown } | null;

        return (
            typeof item?.name === "string" && (!Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.includes("generateContent"))
        );
    });

    return parseModelsResponse({
        data: chat.map((entry) => {
            return { display_name: entry.displayName, id: entry.name.replace(GOOGLE_MODEL_PREFIX_RE, "") };
        }),
    });
};

/** A short slug for a new provider id: satisfies `CUSTOM_PROVIDER_ID_RE`. */
export const generateCustomProviderId = (name: string, taken: ReadonlySet<string>, random: () => string = () => crypto.randomUUID().slice(0, 6)): string => {
    const base = name.toLowerCase().normalize("NFKD").replaceAll(SLUG_INVALID_RE, "-").replaceAll(SLUG_EDGE_DASH_RE, "").slice(0, 24) || "custom";

    for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = attempt === 0 && !taken.has(base) ? base : `${base}-${random()}`;

        if (!taken.has(candidate)) {
            return candidate;
        }
    }

    throw new Error("Could not allocate a provider id");
};

/** Gateway wire format for a stored provider type. */
export const toGatewayFormat = (type: CustomProviderType | undefined): CustomProviderFormat => {
    if (type === "anthropic" || isNativeProvider(type)) {
        return type;
    }

    return "openai-chat";
};

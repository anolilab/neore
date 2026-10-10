import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { NativeProviderFormat } from "@neore/ai/gateway";
import { isNativeProviderFormat } from "@neore/ai/gateway";
import type { GatewayModel } from "@neore/ai/models";
import { buildCustomModelId, parseCustomModelId } from "@neore/ai/models";

/** The client-safe view `chat_custom_providers.listCustomProviders` returns. */
export interface CustomProviderView {
    /** Bedrock: IAM access key id, when the account uses access keys rather than a Bedrock API key. */
    accessKeyId?: string;
    /** Azure: api-version. */
    apiVersion?: string;
    baseUrl: string;
    enabled: boolean;
    hasApiKey: boolean;
    id: string;
    last4?: string;
    models: { id: string; name?: string }[];
    name: string;
    /** Bedrock: AWS region. */
    region?: string;
    supportsTools: boolean;

    /**
     * `local-browser`: a loopback Ollama / LM Studio the browser calls directly (`features/local-models`).
     * `google` / `azure` / `bedrock` / `mistral`: the user's own account with that provider (`native-providers-settings.tsx`).
     */
    type: "anthropic" | "local-browser" | "openai" | NativeProviderFormat;
}

/** A provider-native account (Gemini, Azure OpenAI, Bedrock, Mistral) rather than a compatible endpoint. */
export const isNativeProviderView = (provider: CustomProviderView): provider is CustomProviderView & { type: NativeProviderFormat } =>
    isNativeProviderFormat(provider.type);

/**
 * Turn the user's enabled custom endpoints into picker entries.
 *
 * Grouped under the endpoint's own name (`displayProvider`), text-only, no
 * pricing, and — unless the user opted in — no tool support, which matches what
 * the backend actually sends them.
 */
export const toCustomGatewayModels = (providers: ReadonlyArray<CustomProviderView> | undefined, i18n: Pick<I18n, "_">): GatewayModel[] => {
    if (!providers) {
        return [];
    }

    return providers
        .filter((provider) => provider.enabled)
        .flatMap((provider) =>
            provider.models.map((model): GatewayModel => {
                const isLocal = provider.type === "local-browser";
                const providerName = provider.name;
                let desc = `${providerName} · ${provider.baseUrl}`;

                if (isLocal) {
                    desc = i18n._(msg`${providerName} · runs on this computer, not billed`);
                } else if (isNativeProviderView(provider)) {
                    const region = provider.region ?? "";

                    desc =
                        provider.type === "bedrock"
                            ? i18n._(msg`${providerName} · your own Bedrock account (${region})`)
                            : i18n._(msg`${providerName} · your own API key`);
                }

                return {
                    desc,
                    displayProvider: provider.name,
                    enabled: true,
                    id: buildCustomModelId(provider.id, model.id),
                    mode: "text",
                    modelApiId: model.id,
                    name: model.name ?? model.id,
                    provider: "custom",
                    regions: [],
                    supportsFileInput: false,
                    supportsMultimodal: false,
                    // The browser path sends no tools (nothing there could run them).
                    supportsTools: isLocal ? false : provider.supportsTools,
                };
            }),
        );
};

export interface LocalModelTarget {
    baseUrl: string;
    /** The id the local server knows the model by. */
    modelId: string;
    providerId: string;
    providerName: string;
}

/**
 * The enabled `local-browser` endpoint serving `model`, or `undefined` when the
 * model runs server-side (a platform model or a public custom endpoint). This
 * is the switch between the gateway path and the browser path in chat.
 */
export const findLocalModelTarget = (providers: ReadonlyArray<CustomProviderView> | undefined, model: string | undefined): LocalModelTarget | undefined => {
    const parsed = parseCustomModelId(model);

    if (!parsed || !providers) {
        return undefined;
    }

    const provider = providers.find((entry) => entry.id === parsed.providerId);

    if (!provider?.enabled || provider.type !== "local-browser") {
        return undefined;
    }

    return { baseUrl: provider.baseUrl, modelId: parsed.modelId, providerId: provider.id, providerName: provider.name };
};

const MODEL_LIST_SEPARATOR_RE = /[\n,]/;

/** Parse the free-text model list (one id per line or comma-separated). */
export const parseModelListInput = (input: string): { id: string }[] => {
    const seen = new Set<string>();
    const out: { id: string }[] = [];

    for (const part of input.split(MODEL_LIST_SEPARATOR_RE)) {
        const id = part.trim();

        if (id && !seen.has(id)) {
            seen.add(id);
            out.push({ id });
        }
    }

    return out;
};

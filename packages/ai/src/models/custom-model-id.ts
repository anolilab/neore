/**
 * Namespaced ids for models served by a user-configured custom endpoint
 * (Ollama, LM Studio, vLLM, any OpenAI-compatible server).
 *
 * Shape: `custom:{providerId}/{modelId}`. The provider id is ours (a short slug
 * generated when the endpoint is saved), so it never contains `/`. The model id
 * is the upstream server's and routinely does — `meta-llama/Llama-3.1-8B` on
 * vLLM, `llama3.1:8b` on Ollama — so parsing splits on the FIRST `/` only and
 * keeps everything after it verbatim.
 */

export const CUSTOM_MODEL_PREFIX = "custom:";

/** A provider id: lowercase slug, 1–40 chars, no `/`. */
export const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Upper bound on an upstream model id — generous, but stops pathological input. */
export const CUSTOM_MODEL_ID_MAX_LENGTH = 200;

export interface ParsedCustomModelId {
    modelId: string;
    providerId: string;
}

export const isCustomModelId = (id: string | null | undefined): id is string => typeof id === "string" && id.startsWith(CUSTOM_MODEL_PREFIX);

/**
 * Split a `custom:{providerId}/{modelId}` id. Returns `null` for anything that
 * is not a well-formed custom id — callers treat that as "not a custom model".
 */
export const parseCustomModelId = (id: string | null | undefined): ParsedCustomModelId | null => {
    if (!isCustomModelId(id)) {
        return null;
    }

    const rest = id.slice(CUSTOM_MODEL_PREFIX.length);
    const slash = rest.indexOf("/");

    if (slash <= 0) {
        return null;
    }

    const providerId = rest.slice(0, slash);
    const modelId = rest.slice(slash + 1);

    if (!CUSTOM_PROVIDER_ID_RE.test(providerId) || modelId.length === 0 || modelId.length > CUSTOM_MODEL_ID_MAX_LENGTH || modelId.trim() !== modelId) {
        return null;
    }

    return { modelId, providerId };
};

/** Inverse of {@link parseCustomModelId}. Throws on an invalid provider id. */
export const buildCustomModelId = (providerId: string, modelId: string): string => {
    if (!CUSTOM_PROVIDER_ID_RE.test(providerId)) {
        throw new Error(`Invalid custom provider id: ${providerId}`);
    }

    return `${CUSTOM_MODEL_PREFIX}${providerId}/${modelId}`;
};

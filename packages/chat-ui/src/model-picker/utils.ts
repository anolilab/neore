import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { GatewayModel } from "@neore/ai/models";

/**
 * Known creator slug → display name mapping.
 * Falls back to title-casing the slug for unknown creators.
 */
const CREATOR_DISPLAY_NAMES: Record<string, string> = {
    alibaba: "Alibaba",
    amazon: "Amazon",
    anthropic: "Anthropic",
    baidu: "Baidu",
    "black-forest-labs": "Black Forest Labs",
    bytedance: "ByteDance",
    "bytedance-seed": "ByteDance",
    cohere: "Cohere",
    deepseek: "DeepSeek",
    fal: "fal.ai",
    "fal-ai": "fal.ai",
    google: "Google",
    "ibm-granite": "IBM",
    inception: "Inception",
    inflection: "Inflection",
    liquid: "Liquid",
    meta: "Meta",
    "meta-llama": "Meta",
    microsoft: "Microsoft",
    minimax: "MiniMax",
    mistral: "Mistral",
    mistralai: "Mistral",
    moonshot: "Moonshot",
    moonshotai: "Moonshot",
    morph: "Morph",
    nvidia: "NVIDIA",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    perplexity: "Perplexity",
    qwen: "Qwen",
    "stepfun-ai": "StepFun",
    tencent: "Tencent",
    thudm: "Zhipu AI",
    "x-ai": "xAI",
    xai: "xAI",
    "z-ai": "Zhipu AI",
};

const normalizeProviderSlug = (displayProvider: string): string =>
    displayProvider
        .toLowerCase()
        // The collapse above leaves at most one "-" in a row, so trimming a
        // single leading/trailing dash is enough (and avoids `-+` backtracking).
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-/g, "")
        .replaceAll(/-$/g, "");

export const getCreatorSlug = (model: GatewayModel): string => {
    const rawSlug = normalizeProviderSlug(model.displayProvider ?? model.id.split("/", 1)[0] ?? "unknown");

    const displayName = CREATOR_DISPLAY_NAMES[rawSlug];

    return displayName ? normalizeProviderSlug(displayName) : rawSlug;
};

export const getCreatorDisplayName = (slug: string): string => {
    const displayName = CREATOR_DISPLAY_NAMES[slug];

    if (displayName) {
        return displayName;
    }

    return slug
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
};

export const stripProviderPrefix = (name: string): string => {
    const colonIndex = name.indexOf(":");

    if (colonIndex > 0 && colonIndex < name.length - 1) {
        return name.slice(colonIndex + 1).trim();
    }

    return name;
};

export const getModelMode = (model: GatewayModel): "image" | "speech-to-text" | "text" | "text-to-speech" | "video" => model.mode ?? "text";

const MODEL_MODE_NAMES: Record<string, MessageDescriptor> = {
    image: msg`image generation`,
    "speech-to-text": msg`speech-to-text`,
    text: msg`text`,
    "text-to-speech": msg`text-to-speech`,
    video: msg`video generation`,
};

/** A descriptor — resolve it with `i18n._()` from `useLingui()`. Unknown modes come back as their own id. */
export const getModelModeName = (mode: "image" | "speech-to-text" | "text" | "text-to-speech" | "video" | string): MessageDescriptor =>
    MODEL_MODE_NAMES[mode] ?? { id: mode, message: mode };

export const groupModelsByCreator = (models: GatewayModel[]): Map<string, GatewayModel[]> => {
    const grouped = new Map<string, GatewayModel[]>();

    for (const model of models) {
        const slug = getCreatorSlug(model);
        const displayName = getCreatorDisplayName(slug);

        if (!grouped.has(displayName)) {
            grouped.set(displayName, []);
        }

        grouped.get(displayName)!.push(model);
    }

    return grouped;
};

export const filterModelsByQuery = (models: GatewayModel[], query: string): GatewayModel[] => {
    if (!query.trim()) {
        return models;
    }

    const lowerQuery = query.toLowerCase();

    return models.filter(
        (model) =>
            (model.name?.toLowerCase() ?? "").includes(lowerQuery) ||
            model.id.toLowerCase().includes(lowerQuery) ||
            model.provider?.toLowerCase().includes(lowerQuery) ||
            model.displayProvider?.toLowerCase().includes(lowerQuery) ||
            model.desc?.toLowerCase().includes(lowerQuery),
    );
};

/** Badge labels as descriptors (resolve with `i18n._()`); `id` is stable for keys. */
export const getModelCapabilities = (model: GatewayModel): { id: string; label: MessageDescriptor }[] => {
    const capabilities: { id: string; label: MessageDescriptor }[] = [];

    if (model.filterCapabilities?.includes("fast")) {
        capabilities.push({ id: "fast", label: msg`Fast` });
    }

    if (model.filterCapabilities?.includes("vision")) {
        capabilities.push({ id: "vision", label: msg`Vision` });
    }

    if (model.filterCapabilities?.includes("reasoning")) {
        capabilities.push({ id: "reasoning", label: msg`Reasoning` });
    }

    if (model.filterCapabilities?.includes("effort_control")) {
        capabilities.push({ id: "effort_control", label: msg`Effort Control` });
    }

    if (model.filterCapabilities?.includes("tool_calling")) {
        capabilities.push({ id: "tool_calling", label: msg`Tool Calling` });
    }

    if (!model.filterCapabilities?.includes("tool_calling") && model.supportsTools) {
        capabilities.push({ id: "tool_calling", label: msg`Tool Calling` });
    }

    if (model.filterCapabilities?.includes("image_generation")) {
        capabilities.push({ id: "image_generation", label: msg`Image Generation` });
    }

    if (model.filterCapabilities?.includes("pdf_comprehension")) {
        capabilities.push({ id: "pdf_comprehension", label: { id: "PDF", message: "PDF" } });
    }

    return capabilities;
};

export const findModelById = (models: GatewayModel[], modelId: string | undefined): GatewayModel | undefined => {
    if (!modelId) {
        return undefined;
    }

    return models.find((m) => m.id === modelId);
};

export const formatTokenCount = (value: number | undefined): string => {
    if (value === undefined || value === 0) {
        return "0";
    }

    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }

    if (value >= 1000) {
        return `${(value / 1000).toFixed(0)}K`;
    }

    return value.toString();
};

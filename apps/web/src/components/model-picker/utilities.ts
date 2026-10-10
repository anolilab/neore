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

/**
 * Normalise a displayProvider string to a stable slug for grouping.
 * e.g. "Black Forest Labs" → "black-forest-labs", "xAI" → "xai".
 */
const normalizeProviderSlug = (displayProvider: string): string =>
    displayProvider
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        // A single `-`, not `-+`: the greedy replace above already collapsed every
        // run of non-alphanumerics into one dash, so `-+` can only ever match one
        // character here — and it backtracks quadratically on input that is all
        // separators.
        .replaceAll(/^-|-$/g, "");

/**
 * Extract the creator slug from a model.
 * Prefers the explicit displayProvider field; falls back to the ID prefix.
 * Normalizes through the display name so equivalent slugs (e.g. "meta-llama" and
 * "meta") collapse to the same canonical slug (e.g. "meta").
 */
export const getCreatorSlug = (model: GatewayModel): string => {
    const rawSlug = model.displayProvider ? normalizeProviderSlug(model.displayProvider) : model.id.split("/", 1)[0] || "unknown";

    // Normalize through display name to ensure consistent grouping.
    // e.g. "meta-llama" → "Meta" → "meta", same as displayProvider "Meta" → "meta"
    const displayName = CREATOR_DISPLAY_NAMES[rawSlug];

    return displayName ? normalizeProviderSlug(displayName) : rawSlug;
};

/**
 * Get a human-readable display name for a creator slug.
 */
export const getCreatorDisplayName = (slug: string): string => {
    const displayName = CREATOR_DISPLAY_NAMES[slug];

    if (displayName) {
        return displayName;
    }

    // Fallback: title-case the slug, replacing hyphens with spaces
    return slug
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
};

/**
 * Strip the "Provider: " prefix from model names (e.g., "Meta: Llama 3.1 8B" → "Llama 3.1 8B").
 */
export const stripProviderPrefix = (name: string): string => {
    const colonIndex = name.indexOf(":");

    if (colonIndex > 0 && colonIndex < name.length - 1) {
        return name.slice(colonIndex + 1).trim();
    }

    return name;
};

/**
 * Format pricing value to display format (e.g., $0.0000).
 */
export const formatPricing = (value: number | undefined): string => {
    if (value === undefined || value === 0) {
        return "$0.0000";
    }

    return `$${value.toFixed(4)}`;
};

/**
 * Format context window or token count to display format (e.g., 200K, 32K).
 */
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

/**
 * Check if a model is EU-based
 * All Requesty models are EU.
 */
export const isEUModel = (model: GatewayModel): boolean => {
    // Check if model uses Requesty provider
    const adapterString = `${model.provider}:${model.modelApiId}`;

    if (adapterString.startsWith("requesty:")) {
        return true;
    }

    // Check if displayProvider is requesty
    if (model.displayProvider === "requesty") {
        return true;
    }

    return false;
};

/**
 * Group models by creator (derived from model ID prefix)
 * Returns Map keyed by creator display name.
 */
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

/**
 * Group models by region (EU vs USA).
 */
export const groupModelsByRegion = (models: GatewayModel[]): { eu: GatewayModel[]; usa: GatewayModel[] } => {
    const eu: GatewayModel[] = [];
    const usa: GatewayModel[] = [];

    for (const model of models) {
        if (isEUModel(model)) {
            eu.push(model);
        } else {
            usa.push(model);
        }
    }

    return { eu, usa };
};

/**
 * Everything a picker search matches, lowercased: the name, the id, the
 * creator, the English description and the localized one — so a German user
 * typing German words and anyone typing the registry's English both find the
 * model. Fields are joined by a newline so a query never matches across two of
 * them. Build it once per model per locale, not per keystroke.
 */
export const getModelSearchText = (model: GatewayModel, localizedDescription?: string): string =>
    [model.name, model.id, model.displayProvider, model.desc, localizedDescription].filter(Boolean).join("\n").toLowerCase();

/**
 * Filter models by search query against their precomputed search text
 * (`getModelSearchText`), keyed by model id.
 */
export const filterModelsByQuery = <T extends { model: GatewayModel }>(items: T[], query: string, searchTexts: ReadonlyMap<string, string>): T[] => {
    const lowerQuery = query.trim().toLowerCase();

    if (!lowerQuery) {
        return items;
    }

    return items.filter((item) => (searchTexts.get(item.model.id) ?? getModelSearchText(item.model)).includes(lowerQuery));
};

/**
 * Get model capabilities for badge display.
 */
export const getModelCapabilities = (model: GatewayModel): { label: string }[] => {
    const capabilities: { label: string }[] = [];

    if (model.filterCapabilities?.includes("fast")) {
        capabilities.push({ label: "Fast" });
    }

    if (model.filterCapabilities?.includes("vision")) {
        capabilities.push({ label: "Vision" });
    }

    if (model.filterCapabilities?.includes("reasoning")) {
        capabilities.push({ label: "Reasoning" });
    }

    if (model.filterCapabilities?.includes("effort_control")) {
        capabilities.push({ label: "Effort Control" });
    }

    if (model.filterCapabilities?.includes("tool_calling")) {
        capabilities.push({ label: "Tool Calling" });
    }

    // Check Model capabilities for tool calling if filterCapabilities doesn't have it
    if (!model.filterCapabilities?.includes("tool_calling") && model.supportsTools && capabilities.every((c) => c.label !== "Tool Calling")) {
        capabilities.push({ label: "Tool Calling" });
    }

    if (model.filterCapabilities?.includes("image_generation")) {
        capabilities.push({ label: "Image Generation" });
    }

    if (model.filterCapabilities?.includes("pdf_comprehension")) {
        capabilities.push({ label: "PDF Comprehension" });
    }

    return capabilities;
};

/**
 * Short labels for capability display in model picker badges
 */
export const CAPABILITY_SHORT_LABELS: Record<string, string> = {
    "Effort Control": "Effort",
    Fast: "Fast",
    "Image Generation": "ImgGen",
    "PDF Comprehension": "PDF",
    Reasoning: "Reasoning",
    "Tool Calling": "Tools",
    Vision: "Vision",
};

/**
 * Format date string to short format (e.g., "Jan 2025").
 */
export const formatShortDate = (dateString: string | undefined, locale: string): string => {
    if (!dateString) {
        return "";
    }

    try {
        const date = new Date(dateString);

        if (Number.isNaN(date.getTime())) {
            return dateString;
        }

        return date.toLocaleDateString(locale, { month: "short", year: "numeric" });
    } catch {
        return dateString;
    }
};

/**
 * Get the mode of a model, defaulting to "text" when not specified.
 */
export const getModelMode = (model: GatewayModel): "text" | "image" | "video" | "speech-to-text" | "text-to-speech" => model.mode ?? "text";

/**
 * Human-readable label for a model mode.
 */
export const getModelModeName = (mode: "text" | "image" | "video" | "speech-to-text" | "text-to-speech" | string): string => {
    const names: Record<string, string> = {
        image: "image generation",
        "speech-to-text": "speech-to-text",
        text: "text",
        "text-to-speech": "text-to-speech",
        video: "video generation",
    };

    return names[mode] ?? mode;
};

/**
 * Look up a catalog entry by its gateway id, returning `undefined` when the id
 * is unset or no longer present in the catalog.
 */
export const findModelById = (models: GatewayModel[], modelId: string | undefined): GatewayModel | undefined => {
    if (!modelId) {
        return undefined;
    }

    return models.find((m) => m.id === modelId);
};

/**
 * Format date string to D.M.YYYY format (e.g., "1.11.2024")
 * Returns the formatted date string, or the original string if parsing fails.
 */
export const formatDate = (dateString: string | undefined): string => {
    if (!dateString) {
        return "";
    }

    try {
        const date = new Date(dateString);

        if (Number.isNaN(date.getTime())) {
            // If it's not a valid date, return as-is (might already be in D.M.YYYY format)
            return dateString;
        }

        const day = date.getDate();
        const month = date.getMonth() + 1;
        const year = date.getFullYear();

        return `${day}.${month}.${year}`;
    } catch {
        // If parsing fails, return as-is
        return dateString;
    }
};

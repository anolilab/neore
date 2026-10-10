import type { LanguageModel } from "ai";

import { MODEL_REGISTRY } from "./registry";

/**
 * Base MIME types supported by default for file attachments
 */
export const DEFAULT_FILE_PART_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const;

export const OPENAI_FILE_MIME_TYPES = DEFAULT_FILE_PART_MIME_TYPES;
export const GEMINI_FILE_MIME_TYPES = DEFAULT_FILE_PART_MIME_TYPES;
export const ANTHROPIC_FILE_MIME_TYPES = DEFAULT_FILE_PART_MIME_TYPES;
export const XAI_FILE_MIME_TYPES = DEFAULT_FILE_PART_MIME_TYPES;

/**
 * Set of default supported MIME types for quick lookup
 */
export const DEFAULT_FILE_PART_MIME_SET = new Set(DEFAULT_FILE_PART_MIME_TYPES);

/**
 * MIME types supported for ingestion (CSV files)
 */
export const INGEST_SUPPORTED_MIME = new Set(["application/csv", "text/csv"]);

/**
 * Pre-computed set of model API IDs that do not support tool calling.
 * Derived from MODEL_REGISTRY — no side-effect registration needed.
 */
export const staticUnsupportedModels: ReadonlySet<string> = new Set(MODEL_REGISTRY.filter((m) => m.supportsToolCalling === false).map((m) => m.modelApiId));

const findDefinition = (model: LanguageModel) => {
    const modelId: string = (model as any).modelId ?? "";

    return MODEL_REGISTRY.find((m) => m.modelApiId === modelId || m.id === modelId);
};

/**
 * Check if a MIME type is supported for file parts.
 */
export const isFilePartSupported = (mime?: string, supportedMimeTypes: ReadonlyArray<string> = DEFAULT_FILE_PART_MIME_TYPES): boolean => {
    if (!mime) {
        return false;
    }

    return supportedMimeTypes.includes(mime);
};

/**
 * Check if a MIME type is supported for ingestion (CSV).
 */
export const isIngestSupported = (mime?: string): boolean => {
    if (!mime) {
        return false;
    }

    return INGEST_SUPPORTED_MIME.has(mime);
};

/**
 * Get the supported MIME types for a specific model.
 * Falls back to DEFAULT_FILE_PART_MIME_TYPES if no override is defined.
 */
export const getFilePartSupportedMimeTypes = (model: LanguageModel): ReadonlyArray<string> => {
    const definition = findDefinition(model);

    return definition?.supportedMimeTypes ?? DEFAULT_FILE_PART_MIME_TYPES;
};

/**
 * Check if a model does not support image inputs.
 * Returns true only when supportsImages is explicitly false.
 */
export const isImageInputUnsupportedModel = (model: LanguageModel): boolean => {
    const definition = findDefinition(model);

    return definition?.supportsImages === false;
};

/**
 * Check if a model does not support tool calling.
 * Returns true only when supportsToolCalling is explicitly false.
 */
export const isToolCallUnsupportedModel = (model: LanguageModel): boolean => {
    const definition = findDefinition(model);

    return definition?.supportsToolCalling === false;
};

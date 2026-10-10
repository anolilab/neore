/**
 * Embedding provider factory.
 *
 * Creates AI SDK embedding model instances for each supported provider.
 */
import type { EmbeddingModelV4 } from "@ai-sdk/provider";

import { GatewayError } from "../lib/errors.js";

/** Supported embedding models and their provider mapping */
export interface EmbeddingModelInfo {
    /** Cost per 1M tokens in microdollars */
    costPer1MTokensMicrodollars: number;
    /** Dimensions in the output embedding vector */
    dimensions: number;
    modelApiId: string;
    provider: string;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelInfo> = {
    "embedding-001": { costPer1MTokensMicrodollars: 0, dimensions: 768, modelApiId: "embedding-001", provider: "google" },
    // Groq (via OpenAI-compatible API)
    "nomic-embed-text-v1.5": { costPer1MTokensMicrodollars: 0, dimensions: 768, modelApiId: "nomic-embed-text-v1.5", provider: "groq" },
    "text-embedding-3-large": { costPer1MTokensMicrodollars: 130_000, dimensions: 3072, modelApiId: "text-embedding-3-large", provider: "openai" },
    // OpenAI
    "text-embedding-3-small": { costPer1MTokensMicrodollars: 20_000, dimensions: 1536, modelApiId: "text-embedding-3-small", provider: "openai" },
    // Google
    "text-embedding-004": { costPer1MTokensMicrodollars: 0, dimensions: 768, modelApiId: "text-embedding-004", provider: "google" }, // Free in Gemini API
    "text-embedding-ada-002": { costPer1MTokensMicrodollars: 100_000, dimensions: 1536, modelApiId: "text-embedding-ada-002", provider: "openai" },
};

/**
 * Create an AI SDK embedding model instance for the given provider and model.
 */
export const createEmbeddingModel = async (provider: string, modelApiId: string, apiKey: string): Promise<EmbeddingModelV4> => {
    switch (provider) {
        case "google": {
            const { createGoogleGenerativeAI } = await import("@ai-sdk/google");

            return createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(modelApiId);
        }
        case "groq": {
            // Groq uses an OpenAI-compatible embedding API
            const { createOpenAI } = await import("@ai-sdk/openai");

            return createOpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" }).embedding(modelApiId);
        }
        case "openai": {
            const { createOpenAI } = await import("@ai-sdk/openai");

            return createOpenAI({ apiKey }).embedding(modelApiId);
        }
        default: {
            throw new GatewayError("PROVIDER_NOT_CONFIGURED", `Unsupported embedding provider: ${provider}`);
        }
    }
};

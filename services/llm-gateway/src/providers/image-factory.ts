/**
 * Image provider factory.
 *
 * The image-model catalog is derived from `@neore/ai`'s `MODEL_REGISTRY`
 * (single source of truth). Add or change image models in
 * `packages/ai/src/models/registry.ts` — set `gatewayKey` and
 * `costPerImageMicrodollars` to expose a model here.
 */
import type { ImageModelV4 } from "@ai-sdk/provider";
import type { GatewayImageModelInfo } from "@neore/ai/models";
import { GATEWAY_IMAGE_MODELS } from "@neore/ai/models";

import { GatewayError } from "../lib/errors.js";

/** Image model metadata — re-exported under the gateway's historical name. */
export type ImageModelInfo = GatewayImageModelInfo;

export const IMAGE_MODELS: Record<string, ImageModelInfo> = GATEWAY_IMAGE_MODELS;

/**
 * Create an AI SDK image model instance for the given provider and model.
 */
export const createImageModel = async (provider: string, modelApiId: string, apiKey: string): Promise<ImageModelV4> => {
    switch (provider) {
        case "bfl": {
            const { createBlackForestLabs } = await import("@ai-sdk/black-forest-labs");

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return createBlackForestLabs({ apiKey }).image(modelApiId as any);
        }
        case "fal": {
            const { createFal } = await import("@ai-sdk/fal");

            return createFal({ apiKey }).image(modelApiId as never);
        }
        case "openai": {
            const { createOpenAI } = await import("@ai-sdk/openai");

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return createOpenAI({ apiKey }).image(modelApiId as any);
        }
        default: {
            throw new GatewayError("PROVIDER_NOT_CONFIGURED", `Unsupported image provider: ${provider}`);
        }
    }
};

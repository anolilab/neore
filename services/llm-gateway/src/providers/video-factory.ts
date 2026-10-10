/**
 * Video provider factory.
 *
 * The video-model catalog is derived from `@neore/ai`'s `MODEL_REGISTRY`
 * (single source of truth). Add or change video models in
 * `packages/ai/src/models/registry.ts` — set `gatewayKey`,
 * `costPerSecondMicrodollars`, and the `gateway*` metadata fields to expose
 * a model here.
 *
 * The catalog is shaped to mirror OpenRouter's `GET /api/v1/videos/models`
 * response so `/v1/videos/models` can pass it through without client-side
 * translation.
 */
import type { Experimental_VideoModelV4 } from "@ai-sdk/provider";
import type { GatewayVideoModelInfo, GatewayVideoPricingSkus } from "@neore/ai/models";
import { GATEWAY_VIDEO_MODELS } from "@neore/ai/models";

import { GatewayError } from "../lib/errors.js";

/** OpenRouter-aligned pricing — re-exported for callers. */
export type VideoPricingSkus = GatewayVideoPricingSkus;

/** OpenRouter-aligned model metadata — re-exported under the gateway's historical name. */
export type VideoModelInfo = GatewayVideoModelInfo;

/**
 * Canonical IDs are OpenRouter-style `provider/model`. Bare slugs are NOT
 * accepted — request body `model` must be a canonical slug.
 */
export const VIDEO_MODELS: Record<string, VideoModelInfo> = GATEWAY_VIDEO_MODELS;

/**
 * Create an AI SDK video model instance for the given provider and model.
 */
export const createVideoModel = async (provider: string, modelApiId: string, apiKey: string): Promise<Experimental_VideoModelV4> => {
    if (provider !== "fal") {
        throw new GatewayError("PROVIDER_NOT_CONFIGURED", `Unsupported video provider: ${provider}`);
    }

    const { createFal } = await import("@ai-sdk/fal");

    return createFal({ apiKey }).video(modelApiId as never);
};

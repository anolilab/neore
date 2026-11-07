import type { GatewayModel } from "@neore/ai/models";
import { GLOBAL_REGION } from "@neore/ai/models";
import type { HttpHandler } from "msw";
import { http, HttpResponse } from "msw";

import env from "@/lib/env";

type ModelFixture = Partial<GatewayModel> & Pick<GatewayModel, "id" | "mode" | "name" | "provider">;

const model = (fixture: ModelFixture): GatewayModel => {
    return {
        enabled: true,
        modelApiId: fixture.id,
        regions: ["US"],
        supportsFileInput: false,
        supportsMultimodal: false,
        supportsTools: true,
        ...fixture,
    };
};

/**
 * A small catalog shaped like the gateway's `/v1/models`: several creators, every mode,
 * free (Workers AI, served in every region) and premium models, and region data for the
 * filter rules. Ids follow the real registry, so a story's `initialModelId` reads like the app.
 */
export const MODELS = {
    claudeSonnet: model({
        context_window: 200_000,
        desc: "Strong at long documents, code and careful writing.",
        displayProvider: "Anthropic",
        id: "anthropic/claude-sonnet-4.5",
        isPremium: true,
        mode: "text",
        name: "Claude Sonnet 4.5",
        pricing: { input_per_million: 3, output_per_million: 15 },
        provider: "openrouter",
        regions: ["US", "EU"],
        supportsFileInput: true,
        supportsMultimodal: true,
        tier: "frontier",
    }),
    fluxSchnell: model({
        displayProvider: "Black Forest Labs",
        id: "cf-flux-1-schnell",
        mode: "image",
        name: "FLUX.1 schnell",
        provider: "cloudflare",
        regions: [GLOBAL_REGION],
        supportsTools: false,
        tier: "fast",
    }),
    gemini: model({
        context_window: 1_000_000,
        desc: "Fast multimodal model with a very long context.",
        displayProvider: "Google",
        id: "google/gemini-2.5-flash",
        mode: "text",
        name: "Gemini 2.5 Flash",
        pricing: { input_per_million: 0.3, output_per_million: 2.5 },
        provider: "openrouter",
        regions: ["US", "EU"],
        supportsFileInput: true,
        supportsMultimodal: true,
        tier: "fast",
    }),
    gpt: model({
        context_window: 400_000,
        desc: "OpenAI's flagship reasoning model.",
        displayProvider: "OpenAI",
        id: "openai/gpt-5",
        isPremium: true,
        mode: "text",
        name: "GPT-5",
        pricing: { input_per_million: 1.25, output_per_million: 10 },
        provider: "openrouter",
        supportsFileInput: true,
        supportsMultimodal: true,
        tier: "frontier",
    }),
    imagen: model({
        displayProvider: "Google",
        id: "google/imagen-4",
        isPremium: true,
        mode: "image",
        name: "Imagen 4",
        provider: "fal",
        supportsTools: false,
        tier: "high-quality",
    }),
    kimi: model({
        context_window: 256_000,
        desc: "Open-weight model with strong tool use, run on Workers AI.",
        displayProvider: "Moonshot",
        id: "cf-kimi-k2.5",
        mode: "text",
        name: "Kimi K2.5 (Workers AI)",
        provider: "cloudflare",
        regions: [GLOBAL_REGION],
        tier: "medium",
    }),
    llama: model({
        context_window: 128_000,
        desc: "Meta's open model, run on Workers AI.",
        displayProvider: "Meta",
        id: "cf-llama-4-scout",
        isNew: true,
        mode: "text",
        name: "Llama 4 Scout (Workers AI)",
        provider: "cloudflare",
        regions: [GLOBAL_REGION],
        tier: "budget",
    }),
    mistral: model({
        context_window: 128_000,
        desc: "European model, hosted in the EU.",
        displayProvider: "Mistral",
        id: "mistralai/mistral-medium-3",
        mode: "text",
        name: "Mistral Medium 3",
        pricing: { input_per_million: 0.4, output_per_million: 2 },
        provider: "openrouter",
        regions: ["EU"],
        tier: "medium",
    }),
    veo: model({
        displayProvider: "Google",
        id: "google/veo-3",
        isPremium: true,
        maxVideoDuration: 8,
        mode: "video",
        name: "Veo 3",
        provider: "fal",
        supportsTextToVideo: true,
        supportsTools: false,
        tier: "high-quality",
    }),
    preview: model({
        context_window: 128_000,
        desc: "Only listed while the `model-preview` flag is on.",
        displayProvider: "OpenAI",
        featureFlag: "model-preview",
        id: "openai/gpt-preview",
        isNew: true,
        mode: "text",
        name: "GPT Preview",
        provider: "openrouter",
    }),
    whisper: model({
        displayProvider: "OpenAI",
        id: "cf-whisper-large-v3-turbo",
        mode: "speech-to-text",
        name: "Whisper large v3 turbo",
        provider: "cloudflare",
        regions: [GLOBAL_REGION],
        supportsTools: false,
    }),
} satisfies Record<string, GatewayModel>;

export const MODEL_CATALOG: GatewayModel[] = Object.values(MODELS);

/** The default chat model on a fresh account (`DEFAULT_CHAT_MODEL` in `@neore/ai`, Workers AI since #539). */
export const DEFAULT_MODEL_ID = MODELS.kimi.id;

/** `GET <gateway>/v1/models`. Pass `[]` for an empty catalog, or `"error"` for a gateway that is down. */
export const gatewayModelsHandler = (models: GatewayModel[] | "error" = MODEL_CATALOG): HttpHandler =>
    http.get(`${env.VITE_LLM_GATEWAY_URL}/v1/models`, () =>
        models === "error"
            ? HttpResponse.json({ error: { message: "Gateway unavailable" } }, { status: 503 })
            : HttpResponse.json({ data: models, object: "list", version: "storybook" }),
    );

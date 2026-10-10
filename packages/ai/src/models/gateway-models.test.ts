import { describe, expect, it } from "vitest";

import type { GatewayImageModelInfo, GatewayMusicModelInfo, GatewayVideoModelInfo } from "./gateway-models";
import {
    DEFAULT_SPEECH_MODEL,
    deriveImageModels,
    deriveMusicModels,
    deriveSpeechModels,
    deriveVideoModels,
    GATEWAY_IMAGE_MODELS,
    GATEWAY_MUSIC_MODELS,
    GATEWAY_SPEECH_MODELS,
    GATEWAY_VIDEO_MODELS,
} from "./gateway-models";
import { MODEL_REGISTRY } from "./registry";

// ── deriveImageModels ────────────────────────────────────────────────────────

describe("deriveImageModels", () => {
    const image = deriveImageModels();

    it("returns the same shape as the pre-derived map", () => {
        expect(Object.keys(image).toSorted((a, b) => a.localeCompare(b))).toEqual(Object.keys(GATEWAY_IMAGE_MODELS).toSorted((a, b) => a.localeCompare(b)));
    });

    it("only includes image models with a gatewayKey and costPerImageMicrodollars", () => {
        const expected = MODEL_REGISTRY.filter(
            (m) =>
                m.mode === "image" &&
                m.gatewayKey !== undefined &&
                m.costPerImageMicrodollars !== undefined &&
                (["bfl", "fal", "openai"] as ReadonlyArray<string>).includes(m.provider),
        );

        expect(Object.keys(image)).toHaveLength(expected.length);
    });

    it("only exposes whitelisted providers (bfl | fal | openai)", () => {
        for (const entry of Object.values(image)) {
            expect(["bfl", "fal", "openai"]).toContain(entry.provider);
        }
    });

    it("uses gatewayModelApiId when set, falling back to modelApiId", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "image") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerImageMicrodollars === undefined) continue;

            const entry = image[definition.gatewayKey];

            if (entry === undefined) continue; // skipped by provider whitelist

            expect(entry.modelApiId).toBe(definition.gatewayModelApiId ?? definition.modelApiId);
        }
    });

    it("propagates costPerImageMicrodollars verbatim", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "image") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerImageMicrodollars === undefined) continue;

            const entry = image[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.costPerImageMicrodollars).toBe(definition.costPerImageMicrodollars);
        }
    });

    it("gatewayKeys are unique across image entries", () => {
        const keys = Object.keys(image);

        expect(new Set(keys).size).toBe(keys.length);
    });
});

// ── deriveVideoModels ────────────────────────────────────────────────────────

describe("deriveVideoModels", () => {
    const video = deriveVideoModels();

    it("returns the same shape as the pre-derived map", () => {
        expect(Object.keys(video).toSorted((a, b) => a.localeCompare(b))).toEqual(Object.keys(GATEWAY_VIDEO_MODELS).toSorted((a, b) => a.localeCompare(b)));
    });

    it("only includes video models with a gatewayKey and costPerSecondMicrodollars", () => {
        const expected = MODEL_REGISTRY.filter(
            (m) => m.mode === "video" && m.gatewayKey !== undefined && m.costPerSecondMicrodollars !== undefined && m.provider === "fal",
        );

        expect(Object.keys(video)).toHaveLength(expected.length);
    });

    it("only exposes the fal provider", () => {
        for (const entry of Object.values(video)) {
            expect(entry.provider).toBe("fal");
        }
    });

    it("strips 'auto' from advertised aspect ratios", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "video") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerSecondMicrodollars === undefined) continue;

            const entry = video[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.supportedAspectRatios).not.toContain("auto");
        }
    });

    it("uses canonicalSlug = gatewayKey", () => {
        for (const [key, entry] of Object.entries(video)) {
            expect(entry.canonicalSlug).toBe(key);
        }
    });

    it("falls back to definition.id when name is missing", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "video") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerSecondMicrodollars === undefined) continue;

            const entry = video[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.name).toBe(definition.name ?? definition.id);
        }
    });

    it("falls back to definition.desc when gatewayDescription is missing", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "video") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerSecondMicrodollars === undefined) continue;

            const entry = video[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.description).toBe(definition.gatewayDescription ?? definition.desc ?? "");
        }
    });

    it("derives estimatedLatencySeconds from avgLatencyMs when gatewayEstimatedLatencySeconds is missing", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "video") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerSecondMicrodollars === undefined) continue;

            const entry = video[definition.gatewayKey];

            if (entry === undefined) continue;

            const expected = definition.gatewayEstimatedLatencySeconds ?? (definition.avgLatencyMs ? Math.round(definition.avgLatencyMs / 1000) : 0);

            expect(entry.estimatedLatencySeconds).toBe(expected);
        }
    });

    it("propagates costPerSecondMicrodollars verbatim", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "video") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerSecondMicrodollars === undefined) continue;

            const entry = video[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.costPerSecondMicrodollars).toBe(definition.costPerSecondMicrodollars);
        }
    });

    it("gatewayKeys are unique across video entries", () => {
        const keys = Object.keys(video);

        expect(new Set(keys).size).toBe(keys.length);
    });

    it("every entry exposes the OpenRouter-aligned shape", () => {
        const required: (keyof GatewayVideoModelInfo)[] = [
            "provider",
            "modelApiId",
            "canonicalSlug",
            "name",
            "description",
            "created",
            "supportedResolutions",
            "supportedAspectRatios",
            "supportedSizes",
            "pricingSkus",
            "allowedPassthroughParameters",
            "costPerSecondMicrodollars",
            "estimatedLatencySeconds",
        ];

        for (const entry of Object.values(video)) {
            for (const key of required) {
                expect(entry).toHaveProperty(key);
            }
        }
    });
});

// ── deriveMusicModels ────────────────────────────────────────────────────────

describe("deriveMusicModels", () => {
    const music = deriveMusicModels();

    it("returns the same shape as the pre-derived map", () => {
        expect(Object.keys(music).toSorted((a, b) => a.localeCompare(b))).toEqual(Object.keys(GATEWAY_MUSIC_MODELS).toSorted((a, b) => a.localeCompare(b)));
    });

    it("only includes music models with a gatewayKey and costPerMusicGenerationMicrodollars", () => {
        const expected = MODEL_REGISTRY.filter(
            (m) => m.mode === "music" && m.gatewayKey !== undefined && m.costPerMusicGenerationMicrodollars !== undefined && m.provider === "fal",
        );

        expect(Object.keys(music)).toHaveLength(expected.length);
    });

    it("only exposes the fal provider", () => {
        for (const entry of Object.values(music)) {
            expect(entry.provider).toBe("fal");
        }
    });

    it("uses gatewayModelApiId when set, falling back to modelApiId", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.modelApiId).toBe(definition.gatewayModelApiId ?? definition.modelApiId);
        }
    });

    it("uses canonicalSlug = gatewayKey", () => {
        for (const [key, entry] of Object.entries(music)) {
            expect(entry.canonicalSlug).toBe(key);
        }
    });

    it("falls back to definition.id when name is missing", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.name).toBe(definition.name ?? definition.id);
        }
    });

    it("falls back to definition.desc when gatewayDescription is missing", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.description).toBe(definition.gatewayDescription ?? definition.desc ?? "");
        }
    });

    it("propagates costPerMusicGenerationMicrodollars verbatim", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.costPerMusicGenerationMicrodollars).toBe(definition.costPerMusicGenerationMicrodollars);
        }
    });

    it("propagates supportsNegativePrompt (defaulting to false)", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.supportsNegativePrompt).toBe(definition.supportsNegativePrompt ?? false);
        }
    });

    it("propagates maxMusicDurationSeconds (defaulting to 0)", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.maxDurationSeconds).toBe(definition.maxMusicDurationSeconds ?? 0);
        }
    });

    it("propagates supportedSampleRates and supportedAudioFormats", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            expect(entry.supportedSampleRates).toEqual(definition.supportedSampleRates ?? []);
            expect(entry.supportedAudioFormats).toEqual(definition.supportedAudioFormats ?? []);
        }
    });

    it("derives estimatedLatencySeconds from avgLatencyMs when gatewayEstimatedLatencySeconds is missing", () => {
        for (const definition of MODEL_REGISTRY) {
            if (definition.mode !== "music") continue;

            if (!definition.gatewayKey) continue;

            if (definition.costPerMusicGenerationMicrodollars === undefined) continue;

            const entry = music[definition.gatewayKey];

            if (entry === undefined) continue;

            const expected = definition.gatewayEstimatedLatencySeconds ?? (definition.avgLatencyMs ? Math.round(definition.avgLatencyMs / 1000) : 0);

            expect(entry.estimatedLatencySeconds).toBe(expected);
        }
    });

    it("gatewayKeys are unique across music entries", () => {
        const keys = Object.keys(music);

        expect(new Set(keys).size).toBe(keys.length);
    });

    it("every entry exposes the OpenRouter-aligned shape", () => {
        const required: (keyof GatewayMusicModelInfo)[] = [
            "provider",
            "modelApiId",
            "canonicalSlug",
            "name",
            "description",
            "created",
            "supportedSampleRates",
            "supportedAudioFormats",
            "maxDurationSeconds",
            "allowedPassthroughParameters",
            "costPerMusicGenerationMicrodollars",
            "estimatedLatencySeconds",
            "supportsNegativePrompt",
        ];

        for (const entry of Object.values(music)) {
            for (const key of required) {
                expect(entry).toHaveProperty(key);
            }
        }
    });
});

// ── Cross-map invariants ─────────────────────────────────────────────────────

describe("gateway derivation invariants", () => {
    it("no gatewayKey collisions between image and video maps", () => {
        const imageKeys = new Set(Object.keys(GATEWAY_IMAGE_MODELS));
        const videoKeys = new Set(Object.keys(GATEWAY_VIDEO_MODELS));

        for (const key of imageKeys) {
            expect(videoKeys.has(key)).toBe(false);
        }
    });

    it("no gatewayKey collisions between image and music maps", () => {
        const imageKeys = new Set(Object.keys(GATEWAY_IMAGE_MODELS));
        const musicKeys = new Set(Object.keys(GATEWAY_MUSIC_MODELS));

        for (const key of imageKeys) {
            expect(musicKeys.has(key)).toBe(false);
        }
    });

    it("no gatewayKey collisions between video and music maps", () => {
        const videoKeys = new Set(Object.keys(GATEWAY_VIDEO_MODELS));
        const musicKeys = new Set(Object.keys(GATEWAY_MUSIC_MODELS));

        for (const key of videoKeys) {
            expect(musicKeys.has(key)).toBe(false);
        }
    });

    it("every image entry's provider is in the type union", () => {
        const allowed: GatewayImageModelInfo["provider"][] = ["bfl", "fal", "openai"];

        for (const entry of Object.values(GATEWAY_IMAGE_MODELS)) {
            expect(allowed).toContain(entry.provider);
        }
    });

    it("every video entry's provider is in the type union", () => {
        const allowed: GatewayVideoModelInfo["provider"][] = ["fal"];

        for (const entry of Object.values(GATEWAY_VIDEO_MODELS)) {
            expect(allowed).toContain(entry.provider);
        }
    });

    it("every music entry's provider is in the type union", () => {
        const allowed: GatewayMusicModelInfo["provider"][] = ["fal"];

        for (const entry of Object.values(GATEWAY_MUSIC_MODELS)) {
            expect(allowed).toContain(entry.provider);
        }
    });
});

// ── deriveSpeechModels ───────────────────────────────────────────────────────

describe("deriveSpeechModels", () => {
    const speech = deriveSpeechModels();

    it("keys enabled, priced text-to-speech models by registry id", () => {
        const expected = MODEL_REGISTRY.filter(
            (m) => m.mode === "text-to-speech" && m.enabled !== false && m.costPerThousandCharsMicrodollars !== undefined && m.provider === "fal",
        ).map((m) => m.id);

        expect(Object.keys(speech).toSorted((a, b) => a.localeCompare(b))).toEqual(expected.toSorted((a, b) => a.localeCompare(b)));
        expect(Object.keys(GATEWAY_SPEECH_MODELS)).toEqual(Object.keys(speech));
    });

    it("serves the voice-mode default, with a default voice among its presets", () => {
        const entry = speech[DEFAULT_SPEECH_MODEL];

        expect(entry).toBeDefined();
        expect(entry?.costPerThousandCharsMicrodollars).toBeGreaterThan(0);
        expect(entry?.voices).toContain(entry?.defaultVoice);
    });
});

import type { ModelDefinition } from "@neore/ai/models";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { buildFalReferenceImageInput, buildFalReferenceVideoInput, referenceVideoLimitSeconds } from "./fal-reference-mapping";

const URL_A = "https://files.example.com/a.png";
const URL_B = "https://files.example.com/b.png";
const URL_C = "https://files.example.com/c.png";
const URL_D = "https://files.example.com/d.png";
const URL_E = "https://files.example.com/e.png";
const VIDEO_A = "https://files.example.com/a.mp4";
const VIDEO_B = "https://files.example.com/b.mp4";
const AUDIO_A = "https://files.example.com/a.mp3";
const AUDIO_B = "https://files.example.com/b.mp3";

const modelWithCap = (cap: number | undefined): ModelDefinition => ({ maxReferenceImages: cap }) as unknown as ModelDefinition;

describe("buildFalReferenceImageInput", () => {
    it("returns an empty fragment when refs is undefined", () => {
        expect(buildFalReferenceImageInput(modelWithCap(4), undefined)).toEqual({});
    });

    it("returns an empty fragment when refs is empty", () => {
        expect(buildFalReferenceImageInput(modelWithCap(4), [])).toEqual({});
    });

    it("returns an empty fragment when the model has no reference support (cap undefined)", () => {
        expect(buildFalReferenceImageInput(modelWithCap(undefined), [URL_A])).toEqual({});
    });

    it("returns an empty fragment when the model has cap 0", () => {
        expect(buildFalReferenceImageInput(modelWithCap(0), [URL_A, URL_B])).toEqual({});
    });

    it("returns only image_url for a single-ref-cap model", () => {
        expect(buildFalReferenceImageInput(modelWithCap(1), [URL_A])).toEqual({
            image_url: URL_A,
        });
    });

    it("drops extras above the cap for single-ref models", () => {
        // Single-ref endpoints ignore image_urls; we must not send it.
        expect(buildFalReferenceImageInput(modelWithCap(1), [URL_A, URL_B, URL_C])).toEqual({
            image_url: URL_A,
        });
    });

    it("returns image_url + image_urls for a multi-ref model with multiple refs", () => {
        expect(buildFalReferenceImageInput(modelWithCap(4), [URL_A, URL_B, URL_C])).toEqual({
            image_url: URL_A,
            image_urls: [URL_A, URL_B, URL_C],
        });
    });

    it("does not set image_urls when a multi-ref model only receives one ref", () => {
        // Avoid sending a single-element image_urls array — image_url alone is the
        // canonical single-ref shape.
        expect(buildFalReferenceImageInput(modelWithCap(4), [URL_A])).toEqual({
            image_url: URL_A,
        });
    });

    it("clamps to the cap when refs exceed it on a multi-ref model", () => {
        expect(buildFalReferenceImageInput(modelWithCap(3), [URL_A, URL_B, URL_C, URL_D, URL_E])).toEqual({
            image_url: URL_A,
            image_urls: [URL_A, URL_B, URL_C],
        });
    });

    it("preserves order so the badge index the user saw matches the FAL request", () => {
        const result = buildFalReferenceImageInput(modelWithCap(4), [URL_C, URL_A, URL_B]);

        expect(result.image_url).toBe(URL_C);
        expect(result.image_urls).toEqual([URL_C, URL_A, URL_B]);
    });

    it("preserves duplicate URLs so the caller can anchor on the same image twice", () => {
        // Same-image twice is a legitimate multi-ref pattern (e.g. character
        // weight reinforcement); we must not silently dedupe.
        expect(buildFalReferenceImageInput(modelWithCap(4), [URL_A, URL_A, URL_B])).toEqual({
            image_url: URL_A,
            image_urls: [URL_A, URL_A, URL_B],
        });
    });
});

const videoModel = (modelApiId: string, caps: { audios?: number; images?: number; videos?: number }): ModelDefinition =>
    ({
        maxReferenceAudios: caps.audios,
        maxReferenceImages: caps.images,
        maxReferenceVideos: caps.videos,
        modelApiId,
    }) as unknown as ModelDefinition;

describe("buildFalReferenceVideoInput", () => {
    it("uses the confirmed Seedance field names, puts the start frame first and clamps each modality", () => {
        const model = videoModel("bytedance/seedance-2.0/reference-to-video", { audios: 1, images: 2, videos: 3 });

        expect(
            buildFalReferenceVideoInput(model, {
                referenceAudioUrls: [AUDIO_A, AUDIO_B],
                referenceVideoUrls: [VIDEO_A, VIDEO_B],
                startFrameUrl: URL_C,
            }),
        ).toEqual({
            audio_urls: [AUDIO_A],
            image_urls: [URL_C],
            video_urls: [VIDEO_A, VIDEO_B],
        });
    });

    it("puts the start frame into image_urls for an endpoint that has an image array", () => {
        expect(buildFalReferenceVideoInput(videoModel("bytedance/seedance-2.0/fast/reference-to-video", { images: 4 }), { startFrameUrl: URL_A })).toEqual({
            image_urls: [URL_A],
        });
    });

    it("sends the start frame as image_url for an endpoint with no reference fields", () => {
        expect(buildFalReferenceVideoInput(videoModel("xai/grok-imagine-video/v1.5/image-to-video", {}), { startFrameUrl: URL_A })).toEqual({
            image_url: URL_A,
        });
    });

    it("sends only the start frame as image_url when the model is unknown", () => {
        expect(buildFalReferenceVideoInput(undefined, { referenceVideoUrls: [VIDEO_A], startFrameUrl: URL_A })).toEqual({ image_url: URL_A });
    });

    it("drops modalities the endpoint cannot take (Omni has no audio field)", () => {
        const model = videoModel("google/gemini-omni-flash/v1.1/reference-to-video", { audios: 3, images: 4, videos: 3 });

        expect(buildFalReferenceVideoInput(model, { referenceAudioUrls: [AUDIO_A], referenceVideoUrls: [VIDEO_A] })).toEqual({
            reference_video_urls: [VIDEO_A],
        });
    });

    it("maps every registry row that declares reference videos or audio to a FAL field", () => {
        // Guards the endpoint table against drifting from the registry caps: a
        // declared modality with no field would drop references with no error.
        for (const definition of MODEL_REGISTRY) {
            const out = buildFalReferenceVideoInput(definition, { referenceAudioUrls: [AUDIO_A], referenceVideoUrls: [VIDEO_A] });
            const values = Object.values(out).flatMap((value) => (Array.isArray(value) ? value : [value]));

            if (definition.maxReferenceVideos) {
                expect(values, `${definition.id} video`).toContain(VIDEO_A);
            }

            if (definition.maxReferenceAudios) {
                expect(values, `${definition.id} audio`).toContain(AUDIO_A);
            }
        }
    });
});

describe("referenceVideoLimitSeconds", () => {
    it("reports the combined reference-video length Seedance 2.0 accepts", () => {
        expect(referenceVideoLimitSeconds(videoModel("bytedance/seedance-2.0/reference-to-video", { videos: 3 }))).toBe(15);
    });

    it("reports no limit for a model without one, or with no reference videos", () => {
        expect(referenceVideoLimitSeconds(videoModel("google/gemini-omni-flash/v1.1/reference-to-video", { videos: 3 }))).toBeUndefined();
        expect(referenceVideoLimitSeconds(videoModel("bytedance/seedance-2.0/reference-to-video", {}))).toBeUndefined();
        expect(referenceVideoLimitSeconds(undefined)).toBeUndefined();
    });
});

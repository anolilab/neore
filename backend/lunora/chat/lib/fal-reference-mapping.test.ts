import type { ModelDefinition } from "@neore/ai/models";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import {
    buildFalReferenceImageInput,
    buildFalReferenceVideoInput,
    controlNetImageField,
    falAcceptsAspectRatio,
    falDurationInput,
    falMaskField,
    falVideoOptionInput,
    referenceVideoLimitSeconds,
} from "./fal-reference-mapping";

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

describe("falDurationInput", () => {
    it("sends Seedance 2.0 reference-to-video a string within its 4 to 15 second enum", () => {
        const model = videoModel("bytedance/seedance-2.0/reference-to-video", {});

        expect(falDurationInput(model, 8)).toBe("8");
        expect(falDurationInput(model, 2)).toBe("4");
        expect(falDurationInput(model, 30)).toBe("15");
        expect(falDurationInput(model, 6.4)).toBe("6");
    });

    it("writes each schema's format, snapping to the nearest allowed value", () => {
        // "text": a numeric string; Kling's enum is "5" and "10".
        expect(falDurationInput(videoModel("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", {}), 7)).toBe("5");
        expect(falDurationInput(videoModel("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", {}), 8)).toBe("10");
        // "seconds": a string with an s; Veo 3.1 takes 4s, 6s or 8s.
        expect(falDurationInput(videoModel("fal-ai/veo3.1", {}), 7.5)).toBe("8s");
        // "int": a JSON number; Grok takes 1 to 15.
        expect(falDurationInput(videoModel("xai/grok-imagine-video/v1.5/image-to-video", {}), 30)).toBe(15);
    });

    it("sends the only value a const schema allows", () => {
        expect(falDurationInput(videoModel("fal-ai/veo3.1/reference-to-video", {}), 4)).toBe("8s");
    });

    it("sends no duration to an endpoint whose length is fixed, or when none was asked for", () => {
        expect(falDurationInput(videoModel("fal-ai/ltx-video", {}), 5)).toBeUndefined();
        expect(falDurationInput(videoModel("fal-ai/minimax/hailuo-02/pro/text-to-video", {}), 6)).toBeUndefined();
        expect(falDurationInput(videoModel("bytedance/seedance-2.0/reference-to-video", {}), undefined)).toBeUndefined();
    });

    it("uses the unprefixed Seedance 2.0 and the Kling text-to-video schemas for their repointed ids", () => {
        expect(falDurationInput(videoModel("bytedance/seedance-2.0/text-to-video", {}), 6)).toBe("6");
        expect(falDurationInput(videoModel("fal-ai/kling-video/v1.5/pro/text-to-video", {}), 7)).toBe("5");
    });

    it("keeps the number as given for an unverified endpoint, and for no model", () => {
        expect(falDurationInput(videoModel("fal-ai/unknown/endpoint", {}), 5)).toBe(5);
        expect(falDurationInput(undefined, 5)).toBe(5);
    });
});

describe("falAcceptsAspectRatio", () => {
    it("omits aspect_ratio for endpoints whose schema has no such input", () => {
        expect(falAcceptsAspectRatio(videoModel("xai/grok-imagine-video/v1.5/image-to-video", {}))).toBe(false);
        expect(falAcceptsAspectRatio(videoModel("fal-ai/minimax/hailuo-02/standard/text-to-video", {}))).toBe(false);
        expect(falAcceptsAspectRatio(videoModel("fal-ai/stable-video", {}))).toBe(false);
        expect(falAcceptsAspectRatio(videoModel("fal-ai/veo3.1", {}))).toBe(true);
        expect(falAcceptsAspectRatio(videoModel("fal-ai/unknown/endpoint", {}))).toBe(true);
    });
});

describe("falVideoOptionInput", () => {
    const model = (modelApiId: string) => ({ modelApiId }) as unknown as ModelDefinition;

    it("sends generate_audio and resolution under their FAL names, only to an endpoint that takes them", () => {
        expect(falVideoOptionInput(model("fal-ai/veo3.1/image-to-video"), { generateAudio: false, resolution: "720p" }, true)).toEqual({
            generate_audio: false,
            resolution: "720p",
        });
        expect(falVideoOptionInput(model("fal-ai/kling-video/v1.5/pro/image-to-video"), { generateAudio: true, resolution: "720p" }, true)).toEqual({});
        expect(falVideoOptionInput(undefined, { generateAudio: true, resolution: "720p" }, true)).toEqual({});
    });

    it("holds a free plan to 1080p, and leaves a premium plan's resolution alone", () => {
        expect(falVideoOptionInput(model("fal-ai/veo3.1/image-to-video"), { resolution: "4k" }, false)).toEqual({ resolution: "1080p" });
        expect(falVideoOptionInput(model("fal-ai/veo3.1/image-to-video"), { resolution: "4k" }, true)).toEqual({ resolution: "4k" });
    });
});

describe("start frame field", () => {
    const model = (modelApiId: string, maxReferenceImages?: number) => ({ maxReferenceImages, modelApiId }) as unknown as ModelDefinition;

    it("sends the start frame as start_image_url on the Kling v3 and o3 endpoints that name it so", () => {
        expect(buildFalReferenceVideoInput(model("fal-ai/kling-video/v3/pro/image-to-video"), { startFrameUrl: URL_A })).toEqual({
            start_image_url: URL_A,
        });
        expect(buildFalReferenceVideoInput(model("fal-ai/kling-video/o3/4k/reference-to-video", 4), { startFrameUrl: URL_A })).toEqual({
            start_image_url: URL_A,
        });
    });

    it("sends the start frame into the Veo reference array, and nothing when there is no start frame", () => {
        expect(buildFalReferenceVideoInput(model("fal-ai/veo3.1/reference-to-video", 3), { startFrameUrl: URL_A })).toEqual({ image_urls: [URL_A] });
        expect(buildFalReferenceVideoInput(model("fal-ai/veo3.1/reference-to-video", 3), {})).toEqual({});
    });
});

describe("controlNetImageField", () => {
    it("maps each control type to the field the sdxl union endpoint takes it in", () => {
        expect(controlNetImageField("fal-ai/sdxl-controlnet-union", "pose")).toBe("openpose_image_url");
        expect(controlNetImageField("fal-ai/sdxl-controlnet-union", "softedge")).toBe("teed_image_url");
    });

    it("has no field for a control type or endpoint it does not know, so the action refuses it", () => {
        expect(controlNetImageField("fal-ai/sdxl-controlnet-union", "lineart")).toBeUndefined();
        expect(controlNetImageField("fal-ai/some-other-endpoint", "canny")).toBeUndefined();
        expect(controlNetImageField("fal-ai/sdxl-controlnet-union", "constructor")).toBeUndefined();
    });
});

describe("falMaskField", () => {
    it("names LaMa's mask `mask_image_url` and every other endpoint's `mask_url`", () => {
        expect(falMaskField("fal-ai/lama")).toBe("mask_image_url");
        expect(falMaskField("fal-ai/flux-pro/v1/fill")).toBe("mask_url");
    });
});

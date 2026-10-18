import { describe, expect, it } from "vitest";

import { referenceModeVariants, registryApiIdOf, videoModelPatch } from "./model-options";

describe("registryApiIdOf", () => {
    it("returns the FAL endpoint, not the gateway's alias, for a row the gateway renames", () => {
        expect(registryApiIdOf("fal-ai/kling-video/v1.5/pro")).toBe("fal-ai/kling-video/v1.5/pro/text-to-video");
    });

    it("returns undefined for no model or an unknown one", () => {
        expect(registryApiIdOf(undefined)).toBeUndefined();
        expect(registryApiIdOf("not-a-model")).toBeUndefined();
    });
});

describe("videoModelPatch", () => {
    it("keeps the audio and resolution the new model still takes", () => {
        expect(videoModelPatch("fal-ai/veo3.1/image-to-video", { generateAudio: false, resolution: "4k" })).toEqual({
            generateAudio: false,
            model: "fal-ai/veo3.1/image-to-video",
            resolution: "4k",
        });
    });

    it("clears options a model without them does not take", () => {
        expect(videoModelPatch("fal-ai/kling-video/v1.5/pro/image-to-video", { generateAudio: true, resolution: "4k" })).toEqual({
            generateAudio: undefined,
            model: "fal-ai/kling-video/v1.5/pro/image-to-video",
            resolution: undefined,
        });
    });
});

describe("referenceModeVariants", () => {
    const row = (modelApiId: string, maxReferenceImages?: number) => {
        return { id: modelApiId, maxReferenceImages, modelApiId };
    };

    it("offers the start-frame and reference variants of a family, in that order", () => {
        const candidates = [
            row("bytedance/seedance-2.0/reference-to-video", 4),
            row("bytedance/seedance-2.0/image-to-video"),
            row("bytedance/seedance-2.0/text-to-video"),
        ];

        expect(referenceModeVariants(candidates[0], candidates)).toEqual([
            { id: "bytedance/seedance-2.0/image-to-video", kind: "start-frame" },
            { id: "bytedance/seedance-2.0/reference-to-video", kind: "references" },
        ]);
    });

    it("offers nothing for a reference variant with no registry image cap, or an endpoint without an image array", () => {
        const veo = [row("fal-ai/veo3.1/image-to-video"), row("fal-ai/veo3.1/reference-to-video")];
        const unlisted = [row("fal-ai/pika/v2.2/image-to-video"), row("fal-ai/pika/v2.2/reference-to-video", 4)];

        expect(referenceModeVariants(veo[0], veo)).toEqual([]);
        expect(referenceModeVariants(unlisted[0], unlisted)).toEqual([]);
    });

    it("never offers the first-last-frame variant, and needs both kinds", () => {
        const candidates = [row("fal-ai/veo3.1/image-to-video"), row("fal-ai/veo3.1/first-last-frame-to-video")];

        expect(referenceModeVariants(candidates[0], candidates)).toEqual([]);
    });

    it("does not treat a family's bare id as one of its variants", () => {
        const candidates = [row("fal-ai/veo3.1"), row("fal-ai/veo3.1/image-to-video")];

        expect(referenceModeVariants(candidates[1], candidates)).toEqual([]);
    });
});

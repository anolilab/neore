import { describe, expect, it } from "vitest";

import { exceedsFreePlanCap, FAL_VIDEO_INPUTS, resolutionWithinFreePlan, snapVideoOptions, videoOptionsOf } from "./fal-video-inputs";
import { MODEL_REGISTRY } from "./registry";

const enabledFalVideoRows = MODEL_REGISTRY.filter((row) => row.mode === "video" && row.provider === "fal" && row.enabled !== false);

describe("FAL_VIDEO_INPUTS and the registry", () => {
    it("has an entry for every enabled fal video row, so a new row cannot skip its schema", () => {
        for (const row of enabledFalVideoRows) {
            expect(FAL_VIDEO_INPUTS, row.id).toHaveProperty([row.modelApiId]);
        }
    });

    it("has no entry without an enabled registry row", () => {
        const enabledIds = new Set(enabledFalVideoRows.map((row) => row.modelApiId));

        for (const endpoint of Object.keys(FAL_VIDEO_INPUTS)) {
            expect(enabledIds.has(endpoint), endpoint).toBe(true);
        }
    });

    it("declares a reference field exactly when the registry row caps that modality above zero", () => {
        for (const row of enabledFalVideoRows) {
            const spec = FAL_VIDEO_INPUTS[row.modelApiId];
            const references = spec && spec !== "unverified" ? (spec.references ?? {}) : {};

            expect(Boolean(references.images), `${row.id} images`).toBe((row.maxReferenceImages ?? 0) > 0);
            expect(Boolean(references.videos), `${row.id} videos`).toBe((row.maxReferenceVideos ?? 0) > 0);
            expect(Boolean(references.audios), `${row.id} audios`).toBe((row.maxReferenceAudios ?? 0) > 0);
        }
    });
});

describe("videoOptionsOf", () => {
    it("exposes nothing for an unverified or unknown endpoint", () => {
        expect(videoOptionsOf("fal-ai/bytedance/seedance/v1.5/lite/image-to-video")).toBeUndefined();
        expect(videoOptionsOf("fal-ai/not-in-the-table")).toBeUndefined();
        expect(videoOptionsOf(undefined)).toBeUndefined();
    });

    it("exposes the audio default and resolution list of a verified endpoint", () => {
        expect(videoOptionsOf("fal-ai/veo3.1/image-to-video")).toEqual({
            audioDefault: true,
            resolution: { default: "720p", values: ["720p", "1080p", "4k"] },
        });
    });
});

describe("snapVideoOptions", () => {
    it("keeps audio only where the endpoint has the flag, and resolution only as one of its values", () => {
        expect(snapVideoOptions("fal-ai/veo3/image-to-video", { generateAudio: false, resolution: "1080p" })).toEqual({
            generateAudio: false,
            resolution: "1080p",
        });
        expect(snapVideoOptions("fal-ai/kling-video/v1.5/pro/image-to-video", { generateAudio: true, resolution: "720p" })).toEqual({});
        expect(snapVideoOptions("fal-ai/veo3/image-to-video", { resolution: "4k" })).toEqual({});
    });

    it("matches resolution without case, sending the endpoint's own spelling", () => {
        expect(snapVideoOptions("fal-ai/minimax/hailuo-02/standard/image-to-video", { resolution: "512p" })).toEqual({ resolution: "512P" });
    });

    it("sends nothing for an unset option, and drops everything for an unverified endpoint", () => {
        expect(snapVideoOptions("fal-ai/veo3/image-to-video", {})).toEqual({});
        expect(snapVideoOptions("fal-ai/minimax/hailuo-2.3-fast/standard/text-to-video", { generateAudio: true, resolution: "720p" })).toEqual({});
    });
});

describe("resolutionWithinFreePlan", () => {
    it("snaps a resolution above 1080p down to the endpoint's highest value at or under it", () => {
        expect(resolutionWithinFreePlan("fal-ai/veo3.1/image-to-video", "4k")).toBe("1080p");
        expect(resolutionWithinFreePlan("bytedance/seedance-2.0/reference-to-video", "4k")).toBe("1080p");
    });

    it("keeps a resolution at or under the cap, whatever the endpoint offers above it", () => {
        expect(resolutionWithinFreePlan("fal-ai/veo3.1/image-to-video", "1080p")).toBe("1080p");
        expect(resolutionWithinFreePlan("fal-ai/veo3.1/image-to-video", "720p")).toBe("720p");
        expect(resolutionWithinFreePlan("fal-ai/luma-dream-machine/ray-2", "540p")).toBe("540p");
    });

    it("has no value to fall back to for an endpoint with nothing under the cap, or no resolution input", () => {
        expect(resolutionWithinFreePlan("fal-ai/kling-video/v3/4k/text-to-video", "4k")).toBeUndefined();
        expect(resolutionWithinFreePlan("fal-ai/not-in-the-table", "4k")).toBeUndefined();
    });
});

describe("exceedsFreePlanCap", () => {
    it("is false for a resolution at or under the cap, and for one the endpoint drops", () => {
        expect(exceedsFreePlanCap("fal-ai/veo3.1/image-to-video", "720p")).toBe(false);
        expect(exceedsFreePlanCap("fal-ai/veo3.1/image-to-video", "1080p")).toBe(false);
        // 4k is not a value Seedance 2.0 fast takes, so it is dropped and never reaches the plan check.
        expect(exceedsFreePlanCap("bytedance/seedance-2.0/fast/image-to-video", "4k")).toBe(false);
        expect(exceedsFreePlanCap("fal-ai/not-in-the-table", "4k")).toBe(false);
        expect(exceedsFreePlanCap("fal-ai/veo3.1/image-to-video", undefined)).toBe(false);
    });

    it("is true for a resolution the endpoint takes above the cap", () => {
        expect(exceedsFreePlanCap("fal-ai/veo3.1/image-to-video", "4k")).toBe(true);
    });
});

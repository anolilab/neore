import { describe, expect, it } from "vitest";

import { withPngOutput } from "./output-format";

describe("withPngOutput", () => {
    it("asks FAL, BFL and gpt-image for PNG under each SDK's own options key", () => {
        expect(withPngOutput({}, "fal", "fal-ai/flux/dev")).toEqual({ fal: { outputFormat: "png" } });
        expect(withPngOutput({}, "bfl", "flux-pro-1.1")).toEqual({ blackForestLabs: { outputFormat: "png" } });
        expect(withPngOutput({}, "openai", "gpt-image-1")).toEqual({ openai: { outputFormat: "png" } });
    });

    it("keeps existing options for the same provider", () => {
        expect(withPngOutput({ fal: { image_url: "https://x/y.png" } }, "fal", "m")).toEqual({
            fal: { image_url: "https://x/y.png", outputFormat: "png" },
        });
    });

    it("leaves DALL·E and unknown providers alone", () => {
        expect(withPngOutput({ openai: { style: "vivid" } }, "openai", "dall-e-3")).toEqual({ openai: { style: "vivid" } });
        expect(withPngOutput({}, "openrouter", "google/gemini")).toEqual({});
    });
});

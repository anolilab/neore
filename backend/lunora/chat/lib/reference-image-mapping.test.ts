import type { ModelDefinition } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { buildFalReferenceImageInput } from "./reference-image-mapping";

const URL_A = "https://files.example.com/a.png";
const URL_B = "https://files.example.com/b.png";
const URL_C = "https://files.example.com/c.png";
const URL_D = "https://files.example.com/d.png";
const URL_E = "https://files.example.com/e.png";

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

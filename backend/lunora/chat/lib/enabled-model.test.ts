import { FAL_IMAGE, MODEL_REGISTRY, WORKFLOW_KIND_ACCEPTS } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { requireEnabledModel } from "./enabled-model";

// Fixtures come from the registry, and each one is asserted present, so a changed row fails here rather than passing vacuously.
const findRow = (label: string, predicate: (m: (typeof MODEL_REGISTRY)[number]) => boolean) => {
    const row = MODEL_REGISTRY.find((model) => predicate(model));

    expect(row, label).toBeDefined();

    return row!;
};

const enabledFalImage = findRow("an enabled fal image row", (m) => m.mode === "image" && m.provider === "fal" && m.enabled !== false);
const disabledFalImage = findRow("a disabled fal image row", (m) => m.mode === "image" && m.provider === "fal" && m.enabled === false);
const enabledVideo = findRow("an enabled fal video row", (m) => m.mode === "video" && m.provider === "fal" && m.enabled !== false);

describe("requireEnabledModel", () => {
    it("returns the row for an enabled model of the accepted mode and provider", () => {
        expect(requireEnabledModel(enabledFalImage.id, FAL_IMAGE, "image").id).toBe(enabledFalImage.id);
    });

    it("refuses a disabled row with the same message as an unknown id", () => {
        expect(() => requireEnabledModel(disabledFalImage.id, FAL_IMAGE, "image")).toThrow(`Model ${disabledFalImage.id} is not an enabled image model`);
        expect(() => requireEnabledModel("fal-ai/not-a-real-model", FAL_IMAGE, "image")).toThrow("Model fal-ai/not-a-real-model is not an enabled image model");
    });

    it("refuses a row of another mode", () => {
        expect(() => requireEnabledModel(enabledVideo.id, FAL_IMAGE, "image")).toThrow("is not an enabled image model");
    });

    it("refuses a legacy id: the workflow resolves it to the default before the check", () => {
        expect(() => requireEnabledModel("fal:flux-dev", FAL_IMAGE, "image")).toThrow("is not an enabled image model");
    });

    it("refuses a row that lacks the kind's capability flag", () => {
        const withoutUpscale = findRow(
            "a fal image row without upscaling",
            (m) => m.mode === "image" && m.provider === "fal" && m.enabled !== false && m.supportsUpscale !== true,
        );

        expect(() => requireEnabledModel(withoutUpscale.id, WORKFLOW_KIND_ACCEPTS.upscale, "image upscale")).toThrow("is not an enabled image upscale model");
    });
});

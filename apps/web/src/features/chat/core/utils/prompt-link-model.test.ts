import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { carriableLinkModel } from "./prompt-link-model";

describe(carriableLinkModel, () => {
    it("names an enabled text model the composer picks", () => {
        const textModel = MODEL_REGISTRY.find((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");

        expect(textModel).toBeDefined();
        expect(carriableLinkModel(textModel?.id)?.id).toBe(textModel?.id);
    });

    it("names no model for a custom endpoint, an image model, an external model, an unknown id or nothing", () => {
        const imageModel = MODEL_REGISTRY.find((model) => model.mode === "image" && model.enabled !== false);

        expect(imageModel).toBeDefined();
        expect(carriableLinkModel("custom:ollama/llama3.1:8b")).toBeUndefined();
        expect(carriableLinkModel(imageModel?.id)).toBeUndefined();
        expect(carriableLinkModel("ext/mimo-v2-flash")).toBeUndefined();
        expect(carriableLinkModel("not-a-real-model")).toBeUndefined();
        expect(carriableLinkModel(undefined)).toBeUndefined();
    });
});

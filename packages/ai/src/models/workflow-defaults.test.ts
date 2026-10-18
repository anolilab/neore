import { describe, expect, it } from "vitest";

import { enabledModelOf } from "./enabled-model";
import { MODEL_LOOKUP } from "./registry";
import type { WorkflowModelKind } from "./workflow-defaults";
import { LEGACY_WORKFLOW_MODELS, MEDIA_DEFAULT_MODELS, resolveWorkflowModel, WORKFLOW_KIND_ACCEPTS } from "./workflow-defaults";

describe("MEDIA_DEFAULT_MODELS", () => {
    it.each(Object.entries(MEDIA_DEFAULT_MODELS))("%s default is a row its kind accepts, behind no feature flag", (kind, id) => {
        expect(enabledModelOf(id, WORKFLOW_KIND_ACCEPTS[kind as WorkflowModelKind]), id).toBeDefined();
        expect(MODEL_LOOKUP.get(id)?.featureFlag, id).toBeUndefined();
    });
});

describe("resolveWorkflowModel", () => {
    it("runs the kind's default when the node names none", () => {
        expect(resolveWorkflowModel("image", undefined)).toBe(MEDIA_DEFAULT_MODELS.image);
        expect(resolveWorkflowModel("textToVideo", "")).toBe(MEDIA_DEFAULT_MODELS.textToVideo);
    });

    it("maps a legacy id to the default of the kind it was the default for", () => {
        expect(resolveWorkflowModel("image", "fal:flux-dev")).toBe(MEDIA_DEFAULT_MODELS.image);
        expect(resolveWorkflowModel("transcription", "whisper")).toBe(MEDIA_DEFAULT_MODELS.transcription);
        expect(resolveWorkflowModel("textToVideo", "fal-ai/mochi-v1")).toBe(MEDIA_DEFAULT_MODELS.textToVideo);
    });

    it("passes a legacy id through when the node is another kind, so the action's gate refuses it", () => {
        expect(resolveWorkflowModel("img2img", "fal:flux-dev")).toBe("fal:flux-dev");
        expect(resolveWorkflowModel("image", "whisper")).toBe("whisper");
    });

    it("passes every other id through unchanged, registry rows included", () => {
        expect(resolveWorkflowModel("image", "fal-ai/flux-pro")).toBe("fal-ai/flux-pro");
        expect(resolveWorkflowModel("image", "arbitrary-string")).toBe("arbitrary-string");
        expect(resolveWorkflowModel("image", "constructor")).toBe("constructor");
    });

    it("is idempotent, so an executor and the action can both resolve one id", () => {
        for (const [legacy, kind] of LEGACY_WORKFLOW_MODELS) {
            const once = resolveWorkflowModel(kind, legacy);

            expect(resolveWorkflowModel(kind, once)).toBe(once);
        }
    });
});

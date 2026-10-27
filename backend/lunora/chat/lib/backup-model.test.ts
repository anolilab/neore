import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { backupCanServe, eligibleBackupModel } from "./backup-model";

const textModels = MODEL_REGISTRY.filter((m) => m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text");
const [first, second] = textModels;

describe("eligibleBackupModel", () => {
    it("accepts an enabled text model that is not the primary", () => {
        expect(eligibleBackupModel(second!.id, first!.id)?.id).toBe(second!.id);
    });

    it("is none when unset or blank", () => {
        expect(eligibleBackupModel(undefined, first!.id)).toBeUndefined();
        expect(eligibleBackupModel("", first!.id)).toBeUndefined();
    });

    it("is none when it is the primary", () => {
        expect(eligibleBackupModel(first!.id, first!.id)).toBeUndefined();
    });

    it("is none for an id the registry does not know", () => {
        expect(eligibleBackupModel("no-such-model", first!.id)).toBeUndefined();
        expect(eligibleBackupModel("custom:abc/model", first!.id)).toBeUndefined();
    });

    it("is none for a listed-only, disabled or non-text model", () => {
        const external = MODEL_REGISTRY.find((m) => m.provider === "external");
        const disabled = MODEL_REGISTRY.find((m) => m.enabled === false);
        const image = MODEL_REGISTRY.find((m) => m.mode === "image");

        for (const model of [external, disabled, image]) {
            if (model) {
                expect(eligibleBackupModel(model.id, first!.id)).toBeUndefined();
            }
        }
    });
});

describe("backupCanServe", () => {
    const image = { content: [{ mediaType: "image/png", type: "file" }], role: "user" };
    const aiSdkImage = { content: [{ image: "x", type: "image" }], role: "user" };
    const pdf = { content: [{ mediaType: "application/pdf", type: "file" }], role: "user" };
    const all = { files: true, images: true, tools: true };

    it("takes any call when it supports everything", () => {
        expect(backupCanServe(all, { hasTools: true, messages: [image, pdf] })).toBe(true);
    });

    it("refuses tools, images (as file parts or image parts) and documents it does not support", () => {
        expect(backupCanServe({ ...all, tools: false }, { hasTools: true, messages: [] })).toBe(false);
        expect(backupCanServe({ ...all, images: false }, { hasTools: false, messages: [image] })).toBe(false);
        expect(backupCanServe({ ...all, images: false }, { hasTools: false, messages: [aiSdkImage] })).toBe(false);
        expect(backupCanServe({ ...all, files: false }, { hasTools: false, messages: [pdf] })).toBe(false);
    });

    it("takes a plain-text, tool-free call whatever it supports", () => {
        expect(backupCanServe({ files: false, images: false, tools: false }, { hasTools: false, messages: [{ content: "hi", role: "user" }] })).toBe(true);
        expect(backupCanServe({ files: false, images: true, tools: true }, { hasTools: false, messages: [image] })).toBe(true);
    });
});

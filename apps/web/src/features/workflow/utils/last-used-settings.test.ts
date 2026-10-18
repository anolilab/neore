import { describe, expect, it } from "vitest";

import type { WorkflowNode } from "../types";
import { lastUsedSettings } from "./last-used-settings";

const node = (id: string, type: WorkflowNode["type"], data: Record<string, unknown>): WorkflowNode =>
    ({ data: { label: id, ...data }, id, position: { x: 0, y: 0 }, type }) as unknown as WorkflowNode;

describe("lastUsedSettings", () => {
    it("copies only the allowlisted settings of the most recent node of the type", () => {
        const nodes = [
            node("old", "image", { aspectRatio: "1:1", model: "fal:old" }),
            node("text", "text", { content: "hi", mode: "input" }),
            node("new", "image", {
                aspectRatio: "16:9",
                imageUrl: "https://example.test/a.png",
                label: "Hero",
                mode: "generate",
                model: "fal:new",
                numImages: 2,
                prompt: "a fox",
            }),
        ];

        expect(lastUsedSettings(nodes, "image")).toEqual({ aspectRatio: "16:9", model: "fal:new", numImages: 2 });
    });

    it("never carries prompts, media, results or status, even when the type has settings", () => {
        const nodes = [node("v", "video", { model: "fal:m", negativePrompt: "x", pickedTime: 2, prompt: "p", frameFileIds: { end: "f" } })];

        expect(lastUsedSettings(nodes, "video")).toEqual({ model: "fal:m" });
    });

    it("returns nothing when no node of the type exists or the type has no settings", () => {
        const nodes = [node("i", "image", { model: "fal:m" })];

        expect(lastUsedSettings(nodes, "video")).toEqual({});
        expect(lastUsedSettings(nodes, "text")).toEqual({});
    });

    it("copies arrays so the new node does not share the list", () => {
        const models = ["a", "b"];
        const nodes = [node("p", "parallel-compare", { models })];
        const copied = lastUsedSettings(nodes, "parallel-compare").models as string[];

        expect(copied).toEqual(["a", "b"]);
        expect(copied).not.toBe(models);
    });

    it("carries the audio and resolution choice of the last video and image-to-video node", () => {
        const nodes = [
            node("t2v", "video", { generateAudio: false, model: "fal:m", prompt: "p", resolution: "720p" }),
            node("i2v", "image-to-video", { generateAudio: true, loop: false, model: "fal:i", resolution: "1080p" }),
        ];

        expect(lastUsedSettings(nodes, "video")).toEqual({ generateAudio: false, model: "fal:m", resolution: "720p" });
        expect(lastUsedSettings(nodes, "image-to-video")).toEqual({ generateAudio: true, loop: false, model: "fal:i", resolution: "1080p" });
    });
});

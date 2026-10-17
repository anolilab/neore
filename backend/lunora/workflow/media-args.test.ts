import { describe, expect, it } from "vitest";

import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { imageRequestArgs, videoNodeOutput, workflowInputErrors } from "./media-args";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

describe("videoNodeOutput", () => {
    it("stores an image-to-video clip in the same assets shape a text-to-video result already has", () => {
        const stored = videoNodeOutput({ fileId: "f1", mimeType: "video/mp4", model: "fal-ai/kling", videoUrl: "https://x.example/v.mp4" }, "a fox");

        expect(stored).toStrictEqual({
            assets: [{ fileId: "f1", mimeType: "video/mp4", videoUrl: "https://x.example/v.mp4" }],
            modelId: "fal-ai/kling",
            prompt: "a fox",
        });
    });

    it("passes a text-to-video result through unchanged", () => {
        const result = { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/v.mp4" }], modelId: "fal:mochi-v1", prompt: "a fox" };

        expect(videoNodeOutput(result, "ignored")).toBe(result);
    });
});

describe("imageRequestArgs", () => {
    const context = (edges: WorkflowEdge[], nodes: WorkflowNode[], nodeOutputs: Record<string, unknown>): ExecutionContext => {
        return { graph: { edges, nodes }, nodeOutputs, variables: {} };
    };

    it("takes the last output of the run as the prompt when it is a string", () => {
        // Current behaviour, kept as is: `getLastOutput` is the run's latest output, wired or not.
        const gen = node("gen", "image", { mode: "generate", prompt: "own prompt" });
        const text = node("text", "text", { label: "Idea" });
        const ctx = context([{ id: "e", source: "text", target: "gen" }], [gen, text], { text: "from the text node" });

        expect(imageRequestArgs(gen, ctx).prompt).toBe("from the text node");
    });

    it("sends the reference images the node's mentions number", () => {
        const pic = node("pic", "image", { label: "Frame" });
        const gen = node("gen", "image", { mode: "generate", prompt: "match @Frame" });
        const ctx = context([{ id: "e", source: "pic", target: "gen" }], [gen, pic], { pic: { assets: [{ imageUrl: "https://x.example/p.png" }] } });

        expect(imageRequestArgs(gen, ctx)).toStrictEqual({ prompt: "match image 1", referenceImages: ["https://x.example/p.png"] });
    });
});

describe("workflowInputErrors", () => {
    it("reports a frame wired from a video node that has not captured it, and passes a captured one", () => {
        const target = node("gen", "image-to-video", {});
        const edges: WorkflowEdge[] = [{ id: "e", source: "src", sourceHandle: "frame-start", target: "gen" }];

        expect(workflowInputErrors({ edges, nodes: [node("src", "video", {}), target] })).toStrictEqual([
            "Capture the start frame on the video node before running",
        ]);
        expect(workflowInputErrors({ edges, nodes: [node("src", "video", { frameFileIds: { start: "f" } }), target] })).toStrictEqual([]);
    });
});

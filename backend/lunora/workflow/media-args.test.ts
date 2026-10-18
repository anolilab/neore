import { MEDIA_DEFAULT_MODELS } from "@neore/ai/models";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { executionContextOf } from "./test-execution-context";
import {
    imageRequestArgs,
    imageToVideoArgs,
    runVideoNode,
    textToVideoArgs,
    type WorkflowFileContext,
    videoInputArgs,
    videoNodeOutput,
    videoRunInputError,
    workflowInputErrors,
} from "./media-args";

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

const context = (edges: WorkflowEdge[], nodes: WorkflowNode[], nodeOutputs: Record<string, unknown>): ExecutionContext =>
    executionContextOf({ graph: { edges, nodes }, nodeOutputs });

describe("imageRequestArgs", () => {
    it("takes the last output of the run as the prompt when it is a string", () => {
        // Current behaviour, kept as is: `getLastOutput` is the run's latest output, wired or not.
        const gen = node("gen", "image", { mode: "generate", prompt: "own prompt" });
        const text = node("text", "text", { label: "Idea" });
        const ctx = context([{ id: "e", source: "text", target: "gen" }], [gen, text], { text: "from the text node" });

        expect(imageRequestArgs(gen, ctx).prompt).toBe("from the text node");
    });

    it("numbers an @label of its reference image inside the upstream text it takes as the prompt", () => {
        const pic = node("pic", "image", { label: "Frame" });
        const text = node("text", "text", { label: "Idea" });
        const gen = node("gen", "image", { mode: "generate" });
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "pic", target: "gen" },
            { id: "e2", source: "text", target: "gen" },
        ];
        const ctx = context(edges, [gen, text, pic], { pic: { assets: [{ imageUrl: "https://x.example/p.png" }] }, text: "a cat as in @Frame" });

        expect(imageRequestArgs(gen, ctx)).toStrictEqual({ prompt: "a cat as in image 1", referenceImages: ["https://x.example/p.png"] });
    });

    it("leaves a text label in the upstream text literal, since an image node takes images only", () => {
        const text = node("text", "text", { label: "Idea" });
        const gen = node("gen", "image", { mode: "generate" });
        const ctx = context([{ id: "e", source: "text", target: "gen" }], [gen, text], { text: "see @Idea" });

        expect(imageRequestArgs(gen, ctx).prompt).toBe("see @Idea");
    });

    it("sends the reference images the node's mentions number", () => {
        const pic = node("pic", "image", { label: "Frame" });
        const gen = node("gen", "image", { mode: "generate", prompt: "match @Frame" });
        const ctx = context([{ id: "e", source: "pic", target: "gen" }], [gen, pic], { pic: { assets: [{ imageUrl: "https://x.example/p.png" }] } });

        expect(imageRequestArgs(gen, ctx)).toStrictEqual({ prompt: "match image 1", referenceImages: ["https://x.example/p.png"] });
    });
});

describe("video action arguments", () => {
    const noInputs = { frameUrl: undefined, referenceAudioUrls: [], referenceVideoUrls: [] };

    it("sends the stored options, and ignores a stored value of the wrong type", () => {
        expect(textToVideoArgs(node("v", "video", { generateAudio: false, resolution: "1080p" }), "a fox", noInputs, "u")).toMatchObject({
            generateAudio: false,
            resolution: "1080p",
        });
        expect(imageToVideoArgs(node("v", "video", { generateAudio: "yes", resolution: 1080 }), "https://x.example/i.png", noInputs, "u")).toMatchObject({
            generateAudio: undefined,
            resolution: undefined,
        });
    });

    it("gives text-to-video its defaults and passes the start frame, while image-to-video passes the node's prompt, and never a loop the video node lacks", () => {
        expect(textToVideoArgs(node("v", "video", {}), "a fox", { ...noInputs, frameUrl: "https://x.example/f.png" }, "u")).toMatchObject({
            aspectRatio: "16:9",
            duration: 5,
            model: MEDIA_DEFAULT_MODELS.textToVideo,
            prompt: "a fox",
            startFrameUrl: "https://x.example/f.png",
        });
        const args = imageToVideoArgs(node("v", "video", { loop: true, prompt: "spin" }), "https://x.example/i.png", noInputs, "u");

        expect(args).toMatchObject({ imageUrl: "https://x.example/i.png", prompt: "spin", threadId: "workflow", userId: "u" });
        expect(args.loop).toBeUndefined();
        expect(imageToVideoArgs(node("v", "image-to-video", { loop: true }), "https://x.example/i.png", noInputs, "u").loop).toBe(true);
    });

    it("sends the length the run bills: the default when none is set, and the row's maximum when more is asked", () => {
        const ray2 = "fal-ai/luma-dream-machine/ray-2";

        expect(imageToVideoArgs(node("i", "image-to-video", { model: ray2 }), "https://x.example/i.png", noInputs, "u").duration).toBe(5);
        expect(imageToVideoArgs(node("i", "image-to-video", { duration: 30, model: ray2 }), "https://x.example/i.png", noInputs, "u").duration).toBe(9);
    });
});

describe("videoInputArgs", () => {
    const clipOutput = { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/clip.mp4" }] };
    const frameEdge = (id: string, target: string): WorkflowEdge => {
        return { id, source: "src", sourceHandle: "frame-start", target };
    };

    /** The files a run reads through: one extraction returns `stored-frame`, and every stored file signs to its id. */
    const filesFake = () =>
        ({
            runAction: vi.fn(async () => {
                return { fileId: "stored-frame", mimeType: "image/jpeg" };
            }),
            runQuery: vi.fn(async (_query: unknown, { fileId }: { fileId: string }) => `https://signed.example/${fileId}`),
        }) as unknown as WorkflowFileContext & { runAction: ReturnType<typeof vi.fn> };

    it("extracts a wired frame from its source clip, and hands the stored frame to the target as its start image", async () => {
        const target = node("gen", "video", { mode: "text-to-video" });
        const ctx = context([frameEdge("e", "gen")], [target, node("src", "video", {})], { src: clipOutput });
        const files = filesFake();

        const args = await videoInputArgs(target, ctx, files, "user-1");

        expect(args.frameUrl).toBe("https://signed.example/stored-frame");
        expect(files.runAction).toHaveBeenCalledTimes(1);
        expect(files.runAction.mock.calls[0]?.[1]).toStrictEqual({
            frame: "start",
            threadId: "workflow",
            userId: "user-1",
            videoUrl: "https://x.example/clip.mp4",
        });
    });

    it("extracts a frame once per run when two nodes take it, so it is billed once", async () => {
        const first = node("a", "video", { mode: "text-to-video" });
        const second = node("b", "video", { mode: "text-to-video" });
        const ctx = context([frameEdge("e1", "a"), frameEdge("e2", "b")], [first, second, node("src", "video", {})], { src: clipOutput });
        const files = filesFake();

        await videoInputArgs(first, ctx, files, "user-1");
        const secondArgs = await videoInputArgs(second, ctx, files, "user-1");

        expect(secondArgs.frameUrl).toBe("https://signed.example/stored-frame");
        expect(files.runAction).toHaveBeenCalledTimes(1);
    });

    it("fails before any extraction when the frame's source produced no clip in this run", async () => {
        const target = node("gen", "video", { mode: "text-to-video" });
        const files = filesFake();

        await expect(videoInputArgs(target, context([frameEdge("e", "gen")], [target, node("src", "video", {})], {}), files, "user-1")).rejects.toThrow(
            "needs a clip",
        );
        expect(files.runAction).not.toHaveBeenCalled();
    });
});

describe("workflowInputErrors", () => {
    it("passes a supported frame wire with no capture step, and reports a saved picked-frame wire", () => {
        const target = node("gen", "image-to-video", { model: "fal-ai/bytedance/seedance/v1.5/pro/image-to-video" });
        const edges: WorkflowEdge[] = [{ id: "e", source: "src", sourceHandle: "frame-start", target: "gen" }];

        expect(workflowInputErrors({ edges, nodes: [node("src", "video", {}), target] })).toStrictEqual([]);
        expect(workflowInputErrors({ edges: [{ ...edges[0]!, sourceHandle: "frame-picked" }], nodes: [node("src", "video", {}), target] })).toStrictEqual([
            "The frame-picked handle is no longer supported: add the frame as an image node and wire that instead",
        ]);
    });
});

describe("videoRunInputError", () => {
    it("refuses a text-to-video node with no prompt and no text output, before its frame is extracted", () => {
        const gen = node("gen", "video", { mode: "text-to-video" });

        expect(videoRunInputError(gen, context([], [gen], {}))).toBe("No prompt provided for video generation");
        expect(videoRunInputError(gen, context([{ id: "e", source: "t", target: "gen" }], [gen, node("t", "text", {})], { t: "a fox" }))).toBeUndefined();
    });

    it("needs a start image for image-to-video: a frame wire, or an upstream image", () => {
        const gen = node("gen", "video", { mode: "image-to-video" });
        const frame: WorkflowEdge[] = [{ id: "e", source: "src", sourceHandle: "frame-end", target: "gen" }];

        expect(videoRunInputError(gen, context([], [gen], {}))).toBe("No image input provided for image-to-video mode");
        expect(videoRunInputError(gen, context(frame, [gen, node("src", "video", {})], {}))).toBeUndefined();
    });
});

describe("runVideoNode", () => {
    it("refuses a node with no input before any billing read or quota charge", async () => {
        const actionContext = { runAction: vi.fn(), runMutation: vi.fn(), runQuery: vi.fn() };
        const gen = node("gen", "image-to-video", { label: "Still" });

        await expect(runVideoNode(gen, context([], [gen], {}), actionContext as never, "u")).rejects.toThrow("No image input provided for image-to-video mode");
        expect(actionContext.runQuery).not.toHaveBeenCalled();
        expect(actionContext.runMutation).not.toHaveBeenCalled();
        expect(actionContext.runAction).not.toHaveBeenCalled();
    });
});

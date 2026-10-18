import { MEDIA_DEFAULT_MODELS, MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { executionContextOf } from "./test-execution-context";
import { mediaOf, videoInputErrors } from "./video-inputs";
import {
    imageRequestArgs,
    imageToVideoArgs,
    referenceSecondsOf,
    runVideoNode,
    textToVideoArgs,
    type WorkflowFileContext,
    videoInputArgs,
    videoNodeOutput,
    videoPromptOf,
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

    it("keeps a text-to-video clip's stored file id, so a persisted output is read by id once its URL expires", () => {
        const result = {
            assets: [{ fileId: "f2", mimeType: "video/mp4", videoUrl: "https://x.example/expired.mp4" }],
            modelId: "fal:mochi-v1",
            prompt: "a fox",
        };
        const stored = videoNodeOutput(result, "ignored");

        expect(stored.assets[0]?.fileId).toBe("f2");
        expect(mediaOf(stored)).toStrictEqual({ mimeType: "video/mp4", ref: { fileId: "f2" } });
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

describe("referenceSecondsOf", () => {
    const REFERENCE = "fal-ai/bytedance/seedance-2.0/reference-to-video";
    const videoOutput = { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/r.mp4" }] };
    const videoEdge = (id: string, source: string, target: string): WorkflowEdge => {
        return { id, source, target };
    };

    it("sums the billed lengths of generated reference clips, which are known", () => {
        const target = node("gen", "video", { mode: "text-to-video", model: REFERENCE });
        const generated = node("ref", "video", { duration: 2, mode: "text-to-video", model: "fal/grok-imagine-video-1-5" });
        const ctx = context([videoEdge("e", "ref", "gen")], [target, generated], { ref: videoOutput });

        expect(referenceSecondsOf(target, ctx)).toBe(2);
    });

    it("takes the endpoint's whole reference budget when a wired clip is an upload of unknown length", () => {
        const target = node("gen", "video", { mode: "text-to-video", model: REFERENCE });
        const upload = node("file", "file", {});
        const ctx = context([videoEdge("e", "file", "gen")], [target, upload], { file: videoOutput });

        expect(referenceSecondsOf(target, ctx)).toBe(15);
    });

    it("is zero when no reference video is wired, or the wired output is not a video", () => {
        const target = node("gen", "video", { mode: "text-to-video", model: REFERENCE });
        const text = node("t", "text", {});

        expect(referenceSecondsOf(target, context([], [target], {}))).toBe(0);
        expect(referenceSecondsOf(target, context([videoEdge("e", "t", "gen")], [target, text], { t: "a fox" }))).toBe(0);
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
            runMutation: vi.fn(async () => undefined),
            runQuery: vi.fn(async (_query: unknown, { fileId }: { fileId: string }) => `https://signed.example/${fileId}`),
        }) as unknown as WorkflowFileContext & { runAction: ReturnType<typeof vi.fn>; runMutation: ReturnType<typeof vi.fn> };

    it("extracts a wired frame from its source clip, and hands the stored frame to the target as its start image", async () => {
        const target = node("gen", "video", { mode: "text-to-video" });
        const ctx = context([frameEdge("e", "gen")], [target, node("src", "video", {})], { src: clipOutput });
        const files = filesFake();

        const args = await videoInputArgs(target, ctx, files, "user-1");

        expect(args.frameUrl).toBe("https://signed.example/stored-frame");
        expect(files.runAction).toHaveBeenCalledTimes(1);
        expect(files.runAction.mock.calls[0]?.[1]).toStrictEqual({
            charge: undefined,
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

    it("charges a frame extraction once per run and source clip, at 0.0002 a second of that clip, keyed on the source", async () => {
        const first = node("a", "video", { mode: "text-to-video" });
        const second = node("b", "video", { mode: "text-to-video" });
        const ctx = executionContextOf({
            graph: { edges: [frameEdge("e1", "a"), frameEdge("e2", "b")], nodes: [first, second, node("src", "video", {})] },
            nodeOutputs: { src: clipOutput },
            orgId: "org-1",
        });
        const files = filesFake();

        await videoInputArgs(first, ctx, files, "user-1");
        await videoInputArgs(second, ctx, files, "user-1");

        // The second reader reuses the extraction, so only the first extraction call carries a charge.
        expect(files.runAction).toHaveBeenCalledTimes(1);
        expect(files.runAction.mock.calls[0]?.[1]).toMatchObject({
            charge: {
                costMicrodollars: 1000,
                orgId: "org-1",
                requestId: `workflow-frame:${JSON.stringify(["run", "src", "start"])}`,
            },
        });
    });

    it("sends no charge for a frame extraction in a run with no organization", async () => {
        const target = node("gen", "video", { mode: "text-to-video" });
        const files = filesFake();

        await videoInputArgs(target, context([frameEdge("e", "gen")], [target, node("src", "video", {})], { src: clipOutput }), files, "user-1");
        expect(files.runAction.mock.calls[0]?.[1]).toMatchObject({ charge: undefined });
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

describe("an image-only model in text-to-video mode", () => {
    // An enabled fal row that takes a start image and has no text-to-video: the action refuses it without one.
    const IMAGE_ONLY = "fal-ai/bytedance/seedance/v1.5/pro/image-to-video";
    const picture = { assets: [{ imageUrl: "https://x.example/still.png", mimeType: "image/png" }] };
    const files = {
        runAction: vi.fn(async () => {
            return { fileId: "stored-frame", mimeType: "image/jpeg" };
        }),
        runMutation: vi.fn(),
        runQuery: vi.fn(async (_query: unknown, { fileId }: { fileId: string }) => `https://signed.example/${fileId}`),
    } as unknown as WorkflowFileContext;
    const gen = node("gen", "video", { mode: "text-to-video", model: IMAGE_ONLY, prompt: "a fox" });

    it("sends the wired image as the start frame, and runs past the input check", async () => {
        const ctx = context([{ id: "e", source: "image", target: "gen" }], [gen, node("image", "image")], { image: picture });

        expect(videoRunInputError(gen, ctx)).toBeUndefined();

        const inputs = await videoInputArgs(gen, ctx, files, "user-1");

        expect(inputs.frameUrl).toBe("https://x.example/still.png");
        expect(textToVideoArgs(gen, "a fox", inputs, "user-1").startFrameUrl).toBe("https://x.example/still.png");
    });

    it("sends a wired frame as the start frame, as before", async () => {
        const ctx = context([{ id: "e", source: "src", sourceHandle: "frame-start", target: "gen" }], [gen, node("src", "video", {})], {
            src: { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/clip.mp4" }] },
        });
        const inputs = await videoInputArgs(gen, ctx, files, "user-1");

        expect(inputs.frameUrl).toBe("https://signed.example/stored-frame");
    });

    it("refuses a text wire alone before any extraction or charge", () => {
        const ctx = context([{ id: "e", source: "text", target: "gen" }], [gen, node("text", "text")], { text: "a fox" });

        expect(videoRunInputError(gen, ctx)).toBe("No image input provided: this model needs a start image; wire in an image or a frame");
    });
});

describe("wired inputs are read by role, whatever order the run produced them", () => {
    /** An enabled fal row that takes an image and reference clips, so a reference wire is sent. */
    const referenceRow = MODEL_REGISTRY.find(
        (definition) =>
            definition.mode === "video" &&
            definition.enabled !== false &&
            definition.provider === "fal" &&
            definition.supportsImageToVideo === true &&
            (definition.maxReferenceVideos ?? 0) > 0,
    );

    const picture = { assets: [{ imageUrl: "https://x.example/still.png", mimeType: "image/png" }] };
    const otherPicture = { assets: [{ imageUrl: "https://x.example/other.png", mimeType: "image/png" }] };
    const referenceFileOutput = { fileId: "file-ref", name: "ref.mp4", type: "video/mp4" };
    const files = {
        runAction: vi.fn(),
        runMutation: vi.fn(),
        runQuery: vi.fn(async (_query: unknown, { fileId }: { fileId: string }) => `https://signed.example/${fileId}`),
    } as unknown as WorkflowFileContext;

    /** The run's outputs, inserted in `order`: `getLastOutput` reads the last one. */
    const outputsIn = (order: "first" | "last", entries: Record<string, unknown>) => {
        const keys = Object.keys(entries);

        return Object.fromEntries((order === "last" ? keys : keys.toReversed()).map((key) => [key, entries[key]]));
    };

    const wire = (id: string, source: string, target: string): WorkflowEdge => {
        return { id, source, target };
    };

    it("takes a wired image as the start image and a reference file as the reference clip, in either run order", async () => {
        expect(referenceRow, "an enabled fal row with reference clips").toBeDefined();

        for (const order of ["first", "last"] as const) {
            const target = node("gen", "image-to-video", { model: referenceRow?.id });
            const nodes = [target, node("image", "image"), node("ref", "file", { fileType: "video/mp4" })];
            const edges = [wire("e1", "image", "gen"), wire("e2", "ref", "gen")];
            const ctx = context(edges, nodes, outputsIn(order, { image: picture, ref: referenceFileOutput }));

            expect(videoRunInputError(target, ctx), order).toBeUndefined();

            const args = await videoInputArgs(target, ctx, files, "user-1");

            expect(args.frameUrl, order).toBe("https://x.example/still.png");
            expect(args.referenceVideoUrls, order).toStrictEqual(["https://signed.example/file-ref"]);
        }
    });

    it("takes a wired text as the prompt and a reference file as the reference clip, in either run order", async () => {
        // A row that also does text-to-video: an image-only row would need a start image, which this run has none of.
        const textReferenceRow = MODEL_REGISTRY.find(
            (definition) =>
                definition.mode === "video" &&
                definition.enabled !== false &&
                definition.provider === "fal" &&
                definition.supportsTextToVideo === true &&
                (definition.maxReferenceVideos ?? 0) > 0,
        );

        expect(textReferenceRow, "an enabled fal text-to-video row with reference clips").toBeDefined();

        for (const order of ["first", "last"] as const) {
            const target = node("gen", "video", { mode: "text-to-video", model: textReferenceRow?.id });
            const nodes = [target, node("text", "text"), node("ref", "file", { fileType: "video/mp4" })];
            const edges = [wire("e1", "text", "gen"), wire("e2", "ref", "gen")];
            const ctx = context(edges, nodes, outputsIn(order, { ref: referenceFileOutput, text: "a fox" }));

            expect(videoRunInputError(target, ctx), order).toBeUndefined();
            expect(videoPromptOf(target, ctx), order).toBe("a fox");

            const args = await videoInputArgs(target, ctx, files, "user-1");

            // A text-to-video node never takes an upstream image as its start frame.
            expect(args.frameUrl, order).toBeUndefined();
            expect(args.referenceVideoUrls, order).toStrictEqual(["https://signed.example/file-ref"]);
        }
    });

    it("keeps the first wired image in edge order when two image nodes feed one target, whatever order they ran in", async () => {
        const target = node("gen", "image-to-video", { model: referenceRow?.id });
        const nodes = [target, node("first", "image"), node("second", "image")];
        const edges = [wire("e1", "first", "gen"), wire("e2", "second", "gen")];

        for (const order of ["first", "last"] as const) {
            const ctx = context(edges, nodes, outputsIn(order, { first: picture, second: otherPicture }));

            const args = await videoInputArgs(target, ctx, files, "user-1");

            expect(args.frameUrl, order).toBe("https://x.example/still.png");
        }
    });

    it("refuses a frame wire and a reference-media wire with no prompt, and does not borrow an unrelated latest text output as the prompt", () => {
        const target = node("gen", "video", { mode: "text-to-video" });
        const nodes = [target, node("src", "video"), node("ref", "file", { fileType: "video/mp4" }), node("unrelated", "text")];
        const edges = [{ id: "e1", source: "src", sourceHandle: "frame-end", target: "gen" }, wire("e2", "ref", "gen")];
        const ctx = context(edges, nodes, {
            ref: referenceFileOutput,
            src: { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/c.mp4" }] },
            unrelated: "stray",
        });

        expect(videoRunInputError(target, ctx)).toBe("No prompt provided for video generation");
        expect(videoInputErrors(nodes, edges)).toContain(
            "The end frame feeds a text-to-video node with no prompt; give it a prompt or wire a text node into it",
        );
    });

    it("keeps reading the latest output for a graph whose only wire is one it cannot classify", async () => {
        const text = node("gen", "video", { mode: "text-to-video" });
        const code = node("code", "code");
        const textEdges = [wire("e", "code", "gen")];
        const textCtx = context(textEdges, [text, code], { code: "unclassified", latest: "from the run" });

        expect(videoPromptOf(text, textCtx)).toBe("from the run");

        const image = node("gen", "image-to-video", { model: referenceRow?.id });
        const imageCtx = context(textEdges, [image, code], { code: { url: "https://x.example/code.png" } });

        expect(videoRunInputError(image, imageCtx)).toBeUndefined();
        const args = await videoInputArgs(image, imageCtx, files, "user-1");

        expect(args.frameUrl).toBe("https://x.example/code.png");
    });
});

describe("runVideoNode", () => {
    it("refuses a clip and the frame extraction it needs together when the credits cannot cover both, before any extraction", async () => {
        const target = node("gen", "image-to-video", { label: "Hero", model: "fal-ai/luma-dream-machine/ray-2" });
        const actionContext = {
            runAction: vi.fn(),
            runMutation: vi.fn(),
            runQuery: vi.fn(async (reference: unknown) =>
                reference === internal.auth.billing.creditsLeftQuery ? { creditsLeft: 500 } : { isAdmin: false, plan: "premium" },
            ),
        };
        const frame: WorkflowEdge[] = [{ id: "e", source: "src", sourceHandle: "frame-start", target: "gen" }];
        const ctx = executionContextOf({
            graph: { edges: frame, nodes: [target, node("src", "video", {})] },
            nodeOutputs: { src: { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/c.mp4" }] } },
            orgId: "org-1",
        });

        // The clip is 500 credits (one 5 s block at 540p), the extraction of its 5 s is 1: 501 against 500 left.
        await expect(runVideoNode(target, ctx, actionContext as never, "u")).rejects.toThrow("it costs 501 and 500 are left");
        expect(actionContext.runAction).not.toHaveBeenCalled();
        expect(actionContext.runMutation).not.toHaveBeenCalled();
    });

    it("refuses a node with no input before any billing read or quota charge", async () => {
        const actionContext = { runAction: vi.fn(), runMutation: vi.fn(), runQuery: vi.fn() };
        const gen = node("gen", "image-to-video", { label: "Still" });

        await expect(runVideoNode(gen, context([], [gen], {}), actionContext as never, "u")).rejects.toThrow("No image input provided for image-to-video mode");
        expect(actionContext.runQuery).not.toHaveBeenCalled();
        expect(actionContext.runMutation).not.toHaveBeenCalled();
        expect(actionContext.runAction).not.toHaveBeenCalled();
    });
});

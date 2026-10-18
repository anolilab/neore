import { MEDIA_DEFAULT_MODELS, type ModelDefinition } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { executionContextOf } from "./test-execution-context";
import { frameSourceOf, mediaOf, modelIdFor, resolveMediaUrls, resolveVideoInputs, resolveVideoInputUrls, videoInputErrors } from "./video-inputs";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

const videoNode = node("video", "video", {});
const genNode = node("gen", "video", { mode: "text-to-video" });

/** A registry row that takes a start image and up to 3 reference clips of 15 s in total. */
const SEEDANCE = "fal-ai/bytedance/seedance-2.0/reference-to-video";

const context = (edges: WorkflowEdge[], nodeOutputs: Record<string, unknown> = {}, nodes: WorkflowNode[] = [videoNode, genNode]): ExecutionContext =>
    executionContextOf({ graph: { edges, nodes }, nodeOutputs });

/** A reference-capable model, shaped like a registry row. */
const referenceModel = (caps: { audios?: number; videos?: number }): ModelDefinition =>
    ({
        maxReferenceAudios: caps.audios,
        maxReferenceImages: 4,
        maxReferenceVideos: caps.videos,
        modelApiId: "bytedance/seedance-2.0/reference-to-video",
        supportsImageToVideo: true,
    }) as unknown as ModelDefinition;

const signAll = async (fileId: string) => `https://signed.example/${fileId}`;

describe("resolveVideoInputs", () => {
    it("takes the image from a wired frame handle, not from the last output", () => {
        const edges: WorkflowEdge[] = [{ id: "e1", source: "video", sourceHandle: "frame-end", target: "gen" }];
        const inputs = resolveVideoInputs(genNode, context(edges, { other: { url: "https://x.example/other.png" } }), { fileId: "file-end" });

        expect(inputs.image).toStrictEqual({ fileId: "file-end" });
    });

    it("reads no reference from a frame wire, even one it cannot use", () => {
        const edges: WorkflowEdge[] = [{ id: "e1", source: "video", sourceHandle: "frame-picked", target: "gen" }];
        const outputs = { video: { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/v.mp4" }] } };
        const inputs = resolveVideoInputs(genNode, context(edges, outputs));

        expect(inputs).toStrictEqual({ image: undefined, referenceAudios: [], referenceVideos: [] });
    });

    it("names the last frame wire, and the clip that wire reads", () => {
        const clip = { assets: [{ mimeType: "video/mp4", videoUrl: "https://x.example/v.mp4" }] };
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "video", sourceHandle: "frame-start", target: "gen" },
            { id: "e2", source: "other", sourceHandle: "frame-end", target: "gen" },
        ];
        const nodes = [videoNode, genNode, node("other", "image-to-video")];

        expect(frameSourceOf(genNode, context(edges, { other: clip, video: clip }, nodes))).toStrictEqual({
            clip: { mimeType: "video/mp4", ref: { url: "https://x.example/v.mp4" } },
            kind: "end",
            sourceId: "other",
        });
        expect(frameSourceOf(genNode, context([edges[0]!], { video: clip }))).toMatchObject({ kind: "start", sourceId: "video" });
        expect(frameSourceOf(genNode, context([]))).toBeUndefined();
    });

    it("sorts wired file outputs into reference videos and audios by MIME type", () => {
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "clip", sourceHandle: "output-0", target: "gen" },
            { id: "e2", source: "track", sourceHandle: "output-0", target: "gen" },
            { id: "e3", source: "pic", sourceHandle: "output-0", target: "gen" },
        ];
        const nodes = [videoNode, genNode, node("clip", "file"), node("track", "file"), node("pic", "file")];
        const outputs = {
            clip: { name: "a.mp4", type: "video/mp4", url: "https://x.example/a.mp4" },
            pic: { name: "p.png", type: "image/png", url: "https://x.example/p.png" },
            track: { fileId: "file-audio", name: "a.mp3", type: "audio/mpeg" },
        };
        const inputs = resolveVideoInputs(genNode, context(edges, outputs, nodes));

        expect(inputs.referenceVideos).toStrictEqual([{ url: "https://x.example/a.mp4" }]);
        expect(inputs.referenceAudios).toStrictEqual([{ fileId: "file-audio" }]);
        expect(inputs.image).toBeUndefined();
    });

    it("reads a generated clip by its stored file id, not by the expiring URL it also carries", () => {
        const clip = node("clip", "video");
        const edges: WorkflowEdge[] = [{ id: "e1", source: "clip", sourceHandle: "output-0", target: "gen" }];
        const outputs = { clip: { assets: [{ fileId: "f-stored", mimeType: "video/mp4", videoUrl: "https://signed.example/expiring.mp4" }] } };

        expect(resolveVideoInputs(genNode, context(edges, outputs, [videoNode, genNode, clip])).referenceVideos).toStrictEqual([{ fileId: "f-stored" }]);
    });
});

describe("mediaOf", () => {
    it("reads the audio of a generateAudio answer, which keeps it under assets[0].audioUrl", () => {
        const output = { assets: [{ audioUrl: "https://x.example/a.mp3", mimeType: "audio/mpeg" }], modelId: "openai:tts-1", prompt: "hi" };

        expect(mediaOf(output)).toStrictEqual({ mimeType: "audio/mpeg", ref: { url: "https://x.example/a.mp3" } });
    });

    it("reads nothing from a generateImage answer, whose only URL is an image", () => {
        const output = { assets: [{ imageSize: "1:1", imageUrl: "https://x.example/gen.png", mimeType: "image/png" }], modelId: "fal:flux-dev", prompt: "p" };

        expect(mediaOf(output)).toBeUndefined();
    });

    it("reads an image-to-video clip's stored file, and a file node's upload by its declared type", () => {
        expect(mediaOf({ assets: [{ fileId: "f1", mimeType: "video/mp4", videoUrl: "https://x.example/v.mp4" }] })).toStrictEqual({
            mimeType: "video/mp4",
            ref: { fileId: "f1" },
        });
        expect(mediaOf({ fileId: "f2", name: "a.mov", type: "video/quicktime" })).toStrictEqual({ mimeType: "video/quicktime", ref: { fileId: "f2" } });
        expect(mediaOf("https://x.example/plain")).toBeUndefined();
    });
});

describe("resolveVideoInputUrls", () => {
    const blobVideo = { name: "a.mp4", type: "video/mp4", url: "blob:https://app/abc" };
    const wiredBlobVideo = (): { edges: WorkflowEdge[]; nodes: WorkflowNode[]; outputs: Record<string, unknown> } => {
        return {
            edges: [{ id: "e1", source: "clip", sourceHandle: "output-0", target: "gen" }],
            nodes: [videoNode, genNode, node("clip", "file")],
            outputs: { clip: blobVideo },
        };
    };

    it("ignores a reference video the model cannot take, so an unusable upload never aborts that run", async () => {
        const { edges, nodes, outputs } = wiredBlobVideo();
        const inputs = await resolveVideoInputUrls(genNode, context(edges, outputs, nodes), signAll, undefined);

        expect(inputs).toStrictEqual({ image: undefined, referenceAudioUrls: [], referenceVideoUrls: [] });
    });

    it("resolves reference videos and audio for a model that declares caps, clamped to them", async () => {
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "clip", sourceHandle: "output-0", target: "gen" },
            { id: "e2", source: "track", sourceHandle: "output-0", target: "gen" },
        ];
        const nodes = [videoNode, genNode, node("clip", "video"), node("track", "file")];
        const outputs = {
            clip: { assets: [{ fileId: "f-clip", mimeType: "video/mp4", videoUrl: "https://x.example/c.mp4" }] },
            track: { fileId: "f-track", name: "t.mp3", type: "audio/mpeg" },
        };
        const inputs = await resolveVideoInputUrls(genNode, context(edges, outputs, nodes), signAll, referenceModel({ audios: 1, videos: 3 }));

        expect(inputs).toStrictEqual({
            image: undefined,
            referenceAudioUrls: ["https://signed.example/f-track"],
            referenceVideoUrls: ["https://signed.example/f-clip"],
        });
    });

    it("still rejects an unusable reference for a model that does take references", async () => {
        const { edges, nodes, outputs } = wiredBlobVideo();

        await expect(resolveVideoInputUrls(genNode, context(edges, outputs, nodes), signAll, referenceModel({ videos: 3 }))).rejects.toThrow(
            "not available as a public URL",
        );
    });

    it("resolves a frame through the signer, and keeps the image path for a file reference", async () => {
        const inputs = await resolveVideoInputUrls(
            genNode,
            context([{ id: "e1", source: "video", sourceHandle: "frame-end", target: "gen" }]),
            signAll,
            undefined,
            { fileId: "file-end" },
        );

        expect(inputs.image).toBe("https://signed.example/file-end");
    });
});

describe("resolveMediaUrls", () => {
    it("signs stored files and accepts only http(s) URLs", async () => {
        const urls = await resolveMediaUrls([{ fileId: "f1" }, { url: "https://x.example/a.mp4" }], async (id) => `https://signed.example/${id}`);

        expect(urls).toStrictEqual(["https://signed.example/f1", "https://x.example/a.mp4"]);
        await expect(resolveMediaUrls([{ url: "blob:https://app/abc" }], async () => null)).rejects.toThrow("not available as a public URL");
        await expect(resolveMediaUrls([{ fileId: "f2" }], async () => null)).rejects.toThrow("missing or no longer shared");
    });
});

describe("modelIdFor", () => {
    it("gives a video node its kind's workflow default when it names none, and a stored id as given", () => {
        expect(modelIdFor(node("v", "video", { mode: "text-to-video" }), "textToVideo")).toBe(MEDIA_DEFAULT_MODELS.textToVideo);
        expect(modelIdFor(node("v", "video", { mode: "image-to-video" }), "imageToVideo")).toBe(MEDIA_DEFAULT_MODELS.imageToVideo);
        expect(modelIdFor(node("i", "image-to-video", { model: SEEDANCE }), "imageToVideo")).toBe(SEEDANCE);
        expect(modelIdFor(node("v", "video", { mode: "text-to-video", model: "fal:mochi-v1" }), "textToVideo")).toBe(MEDIA_DEFAULT_MODELS.textToVideo);
    });
});

describe("videoInputErrors", () => {
    it("accepts a frame from a video node into a video node, with no capture step", () => {
        const nodes = [node("src", "video", { label: "Clip" }), node("gen", "image-to-video", { mode: "image-to-video", model: SEEDANCE })];

        expect(videoInputErrors(nodes, [{ id: "e1", source: "src", sourceHandle: "frame-end", target: "gen" }])).toStrictEqual([]);
    });

    it("rejects a frame into a model that cannot take an image, before any extraction is paid for", () => {
        const nodes = [node("src", "video", {}), node("gen", "video", { mode: "text-to-video", model: "fal:mochi-v1", prompt: "a fox" })];

        expect(videoInputErrors(nodes, [{ id: "e", source: "src", sourceHandle: "frame-start", target: "gen" }])).toStrictEqual([
            "The start frame needs a model that takes an image input; fal-ai/ltx-video does not",
        ]);
    });

    it("accepts an image-to-video node that sets no model, since the workflow default takes an image", () => {
        const nodes = [node("src", "video", {}), node("gen", "image-to-video", { mode: "image-to-video" })];

        expect(MEDIA_DEFAULT_MODELS.imageToVideo).toBeDefined();
        expect(videoInputErrors(nodes, [{ id: "e", source: "src", sourceHandle: "frame-end", target: "gen" }])).toStrictEqual([]);
    });

    it("rejects a frame into a text-to-video node that has no prompt and no text wired in", () => {
        const nodes = [node("src", "video", {}), node("gen", "video", { mode: "text-to-video", model: SEEDANCE })];
        const edges: WorkflowEdge[] = [{ id: "e", source: "src", sourceHandle: "frame-start", target: "gen" }];

        expect(videoInputErrors(nodes, edges)).toStrictEqual([
            "The start frame feeds a text-to-video node with no prompt; give it a prompt or wire a text node into it",
        ]);
        expect(
            videoInputErrors([...nodes.slice(0, 1), node("gen", "video", { mode: "text-to-video", model: SEEDANCE, prompt: "a fox" })], edges),
        ).toStrictEqual([]);
        expect(videoInputErrors([...nodes, node("txt", "text", {})], [...edges, { id: "t", source: "txt", target: "gen" }])).toStrictEqual([]);
    });

    it("rejects a frame that runs into a node that does not read it, or out of a node with no clip", () => {
        const source = node("src", "video", {});
        const wrongTarget = node("img", "text", {});
        const imageSource = node("pic", "image", {});

        expect(videoInputErrors([source, wrongTarget], [{ id: "e", source: "src", sourceHandle: "frame-end", target: "img" }])).toStrictEqual([
            "The end frame must go from a video or image-to-video node into a video or image-to-video node",
        ]);
        expect(videoInputErrors([imageSource, node("gen", "video")], [{ id: "e", source: "pic", sourceHandle: "frame-start", target: "gen" }])).toStrictEqual([
            "The start frame must go from a video or image-to-video node into a video or image-to-video node",
        ]);
    });

    it("reports a saved picked-frame wire, which is no longer a handle", () => {
        const nodes = [node("src", "video", {}), node("gen", "video", {})];

        expect(videoInputErrors(nodes, [{ id: "e", source: "src", sourceHandle: "frame-picked", target: "gen" }])).toStrictEqual([
            "The frame-picked handle is no longer supported: add the frame as an image node and wire that instead",
        ]);
    });

    it("rejects reference clips whose known durations exceed the model's budget, and skips unknown ones", () => {
        const long = node("long", "video", { duration: 10 });
        const alsoLong = node("long2", "video", { duration: 8 });
        const upload = node("upload", "file", {});
        const target = node("gen", "video", { mode: "text-to-video", model: SEEDANCE });
        const over = [long, alsoLong, target];
        const overEdges: WorkflowEdge[] = [
            { id: "e1", source: "long", target: "gen" },
            { id: "e2", source: "long2", target: "gen" },
        ];

        expect(videoInputErrors(over, overEdges)).toStrictEqual([`The reference clips total 18s; ${SEEDANCE} accepts at most 15s of reference video`]);

        const underEdges: WorkflowEdge[] = [
            { id: "e1", source: "long", target: "gen" },
            { id: "e3", source: "upload", target: "gen" },
        ];

        expect(videoInputErrors([long, upload, target], underEdges)).toStrictEqual([]);
    });

    it("counts a text-to-video source with no duration as the 5 s the executor requests", () => {
        const defaultClip = node("default", "video", { mode: "text-to-video" });
        const target = node("gen", "video", { mode: "text-to-video", model: SEEDANCE });
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "default", target: "gen" },
            { id: "e2", source: "default", target: "gen" },
            { id: "e3", source: "default", target: "gen" },
        ];

        // Three wires, each 5 s, is 15 s: within the budget.
        expect(videoInputErrors([defaultClip, target], edges)).toStrictEqual([]);
        // A fourth reference over the budget is caught.
        expect(videoInputErrors([defaultClip, target], [...edges, { id: "e4", source: "default", target: "gen" }])).toHaveLength(1);
    });
});

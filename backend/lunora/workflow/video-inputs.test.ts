import type { ModelDefinition } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { mediaOf, modelIdFor, resolveMediaUrls, resolveVideoInputs, resolveVideoInputUrls, videoInputErrors } from "./video-inputs";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

const videoNode = node("video", "video", { frameFileIds: { end: "file-end" } });
const genNode = node("gen", "video", { mode: "text-to-video" });

const context = (edges: WorkflowEdge[], nodeOutputs: Record<string, unknown> = {}, nodes: WorkflowNode[] = [videoNode, genNode]): ExecutionContext => {
    return { graph: { edges, nodes }, nodeOutputs, variables: {} };
};

/** A reference-capable model, shaped like a registry row. */
const referenceModel = (caps: { audios?: number; videos?: number }): ModelDefinition =>
    ({
        maxReferenceAudios: caps.audios,
        maxReferenceImages: 4,
        maxReferenceVideos: caps.videos,
        modelApiId: "bytedance/seedance-2.0/reference-to-video",
    }) as unknown as ModelDefinition;

const signAll = async (fileId: string) => `https://signed.example/${fileId}`;

describe("resolveVideoInputs", () => {
    it("takes the image from a wired frame handle, not from the last output", () => {
        const edges: WorkflowEdge[] = [{ id: "e1", source: "video", sourceHandle: "frame-end", target: "gen" }];
        const inputs = resolveVideoInputs(genNode, context(edges, { other: { url: "https://x.example/other.png" } }));

        expect(inputs.image).toStrictEqual({ fileId: "file-end" });
    });

    it("throws when the wired frame has not been captured", () => {
        const edges: WorkflowEdge[] = [{ id: "e1", source: "video", sourceHandle: "frame-start", target: "gen" }];

        expect(() => resolveVideoInputs(genNode, context(edges))).toThrow("Capture the start frame");
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
    it("gives a text-to-video node the executor's default model, and an image-to-video node only its own", () => {
        expect(modelIdFor(node("v", "video", { mode: "text-to-video" }))).toBe("fal:mochi-v1");
        expect(modelIdFor(node("v", "video", { mode: "image-to-video" }))).toBeUndefined();
        expect(modelIdFor(node("i", "image-to-video", { model: "fal:kling" }))).toBe("fal:kling");
    });
});

describe("videoInputErrors", () => {
    const modelOf = (modelId: string) => (modelId === "seedance" ? referenceModel({ audios: 3, videos: 3 }) : undefined);

    it("rejects a frame that is not captured on its source, before any clip is generated", () => {
        const nodes = [node("src", "video", { label: "Clip" }), node("gen", "video", { mode: "image-to-video" })];
        const edges: WorkflowEdge[] = [{ id: "e1", source: "src", sourceHandle: "frame-end", target: "gen" }];

        expect(videoInputErrors(nodes, edges, modelOf)).toStrictEqual(["Capture the end frame on the video node before running"]);
    });

    it("accepts a captured frame, and rejects a frame wired into a node that does not read it", () => {
        const captured = node("src", "video", { frameFileIds: { end: "f" } });
        const wrongTarget = node("img", "text", {});

        expect(
            videoInputErrors([captured, node("gen", "video")], [{ id: "e", source: "src", sourceHandle: "frame-end", target: "gen" }], modelOf),
        ).toStrictEqual([]);
        expect(videoInputErrors([captured, wrongTarget], [{ id: "e", source: "src", sourceHandle: "frame-end", target: "img" }], modelOf)).toStrictEqual([
            "The end frame can only feed a video or image-to-video node",
        ]);
    });

    it("rejects reference clips whose known durations exceed the model's budget, and skips unknown ones", () => {
        const long = node("long", "video", { duration: 10 });
        const alsoLong = node("long2", "video", { duration: 8 });
        const upload = node("upload", "file", {});
        const target = node("gen", "video", { mode: "text-to-video", model: "seedance" });
        const over = [long, alsoLong, target];
        const overEdges: WorkflowEdge[] = [
            { id: "e1", source: "long", target: "gen" },
            { id: "e2", source: "long2", target: "gen" },
        ];

        expect(videoInputErrors(over, overEdges, modelOf)).toStrictEqual(["The reference clips total 18s; seedance accepts at most 15s of reference video"]);

        const underEdges: WorkflowEdge[] = [
            { id: "e1", source: "long", target: "gen" },
            { id: "e3", source: "upload", target: "gen" },
        ];

        expect(videoInputErrors([long, upload, target], underEdges, modelOf)).toStrictEqual([]);
    });

    it("counts a text-to-video source with no duration as the 5 s the executor requests", () => {
        const defaultClip = node("default", "video", { mode: "text-to-video" });
        const target = node("gen", "video", { mode: "text-to-video", model: "seedance" });
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "default", target: "gen" },
            { id: "e2", source: "default", target: "gen" },
            { id: "e3", source: "default", target: "gen" },
        ];

        // Three wires, each 5 s, is 15 s: within the budget.
        expect(videoInputErrors([defaultClip, target], edges, modelOf)).toStrictEqual([]);
        // A fourth reference over the budget is caught.
        expect(videoInputErrors([defaultClip, target], [...edges, { id: "e4", source: "default", target: "gen" }], modelOf)).toHaveLength(1);
    });
});

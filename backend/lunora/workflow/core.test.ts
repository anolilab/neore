import { describe, expect, it } from "vitest";

import { executionContextOf } from "./test-execution-context";
import type { ExecutionContext, WorkflowEdge, WorkflowNode } from "./core";
import { executeFileNode, extractUrl, getNodeInput, sourceNodesOf } from "./core";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

const context = (edges: WorkflowEdge[], nodes: WorkflowNode[], nodeOutputs: Record<string, unknown> = {}): ExecutionContext =>
    executionContextOf({ graph: { edges, nodes }, nodeOutputs });

describe("extractUrl", () => {
    it("reads a string as the URL itself", () => {
        expect(extractUrl("https://x.example/a.png", "imageUrl")).toBe("https://x.example/a.png");
    });

    it("reads an object's url, then the first of the named keys it has", () => {
        expect(extractUrl({ url: "https://x.example/u" }, "imageUrl")).toBe("https://x.example/u");
        expect(extractUrl({ imageUrl: "https://x.example/i" }, "imageUrl")).toBe("https://x.example/i");
        expect(extractUrl({ videoUrl: "https://x.example/v" }, "imageUrl")).toBeUndefined();
    });

    it("reads the first asset of a generation's output, as generateImage and generateAudio return it", () => {
        const image = { assets: [{ imageSize: "1:1", imageUrl: "https://x.example/gen.png", mimeType: "image/png" }], modelId: "fal:flux-dev", prompt: "p" };
        const audio = { assets: [{ audioUrl: "https://x.example/a.mp3", mimeType: "audio/mpeg" }], modelId: "openai:tts-1", prompt: "p" };

        expect(extractUrl(image, "imageUrl")).toBe("https://x.example/gen.png");
        expect(extractUrl(audio, "audioUrl")).toBe("https://x.example/a.mp3");
        expect(extractUrl(image, "audioUrl")).toBeUndefined();
        expect(extractUrl({ assets: [] }, "imageUrl")).toBeUndefined();
    });
});

describe("sourceNodesOf", () => {
    it("pairs each incoming edge with its source, keeping the handle the edge names", () => {
        const video = node("video", "video", { frameFileIds: { end: "file-end" } });
        const gen = node("gen", "video", { mode: "text-to-video" });
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "video", sourceHandle: "frame-end", target: "gen" },
            { id: "e2", source: "video", sourceHandle: "output-0", target: "gen" },
            { id: "e3", source: "other", target: "elsewhere" },
        ];
        const pairs = sourceNodesOf(gen, context(edges, [video, gen]));

        expect(pairs.map(({ edge, node: source }) => [edge.id, source.id, edge.sourceHandle])).toStrictEqual([
            ["e1", "video", "frame-end"],
            ["e2", "video", "output-0"],
        ]);
    });
});

describe("getNodeInput", () => {
    it("reads the wired sources from the context's own edges", () => {
        const a = node("a", "text");
        const b = node("b", "text");
        const c = node("c", "text");
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "a", target: "c" },
            { id: "e2", source: "b", target: "c" },
        ];
        const ctx = context(edges, [a, b, c], { a: "one", b: "two" });

        expect(getNodeInput("c", ctx)).toStrictEqual(["one", "two"]);
        expect(getNodeInput("a", ctx)).toBeUndefined();
    });
});

describe("executeFileNode", () => {
    it("keeps the stored file id beside a signed url, so a later run signs the file again instead of sending an expired link", () => {
        const result = executeFileNode(
            node("f", "file", { fileId: "file-1", fileName: "a.mp4", fileType: "video/mp4", fileUrl: "https://signed.example/a.mp4?sig=1" }),
        );

        expect(result.output).toStrictEqual({ fileId: "file-1", name: "a.mp4", type: "video/mp4", url: "https://signed.example/a.mp4?sig=1" });
    });

    it("still returns just the url for a file with no stored id, and just the id when there is no url", () => {
        expect(executeFileNode(node("f", "file", { fileName: "a.png", fileType: "image/png", fileUrl: "https://x.example/a.png" })).output).toStrictEqual({
            name: "a.png",
            type: "image/png",
            url: "https://x.example/a.png",
        });
        expect(executeFileNode(node("f", "file", { fileId: "file-2", fileName: "a.png", fileType: "image/png" })).output).toStrictEqual({
            fileId: "file-2",
            name: "a.png",
            type: "image/png",
        });
    });
});

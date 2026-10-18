import { describe, expect, it } from "vitest";

import type { WorkflowEdge, WorkflowNode } from "./core";
import { executeTextNode, expandNodeMentions, mentionTargetsFor, referenceImageSourceIds, referenceImageUrls } from "./mention-targets";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

const labelled = (id: string, type: string, label: string): WorkflowNode => node(id, type, { label });

describe("mentions in a text template", () => {
    const mentionContext = (template: string, outputs: Record<string, unknown>, sources: WorkflowNode[]) => {
        const target = node("tpl", "text", { mode: "transform", template });
        const edges: WorkflowEdge[] = sources.map((source) => {
            return { id: `e-${source.id}`, source: source.id, target: "tpl" };
        });

        return { context: { graph: { edges, nodes: [target, ...sources] }, nodeOutputs: outputs, variables: {} }, node: target };
    };

    it("substitutes a connected text node's output and leaves an ambiguous label literal", () => {
        const sources = [labelled("a", "text", "Notes"), labelled("b", "ai", "Summary"), labelled("c", "text", "Summary")];
        const { context: ctx, node: target } = mentionContext("@Notes / @Summary / {{input}}", { a: "north", b: "s1", c: "s2" }, sources);

        expect(executeTextNode(target, ctx).output).toBe("north / @Summary / s2");
    });

    it("escapes a mentioned output in a JSON template, so a quote or newline in it keeps the document valid", () => {
        const sources = [labelled("a", "text", "Notes")];
        const target = node("tpl", "text", { format: "json", mode: "transform", template: '{"subject": "@Notes"}' });
        const ctx = {
            graph: { edges: [{ id: "e", source: "a", target: "tpl" }], nodes: [target, ...sources] },
            nodeOutputs: { a: 'He said "hi"\nbye' },
            variables: {},
        };

        expect(JSON.parse(executeTextNode(target, ctx).output as string)).toEqual({ subject: 'He said "hi"\nbye' });
    });

    it("lists the image inputs of a node in edge order, one per source, and numbers mentions by it", () => {
        const sources = [labelled("pic", "image", "Frame"), labelled("note", "text", "Note"), labelled("ref", "style-ref", "Style")];
        const outputs = { note: "x", pic: "https://x.example/p.png", ref: { imageUrl: "https://x.example/r.png" } };
        const gen = node("gen", "image", { label: "Gen", mode: "generate" });
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "ref", target: "gen" },
            { id: "e2", source: "note", target: "gen" },
            { id: "e3", source: "pic", target: "gen" },
            { id: "e4", source: "pic", target: "gen", targetHandle: "second" },
        ];
        const ctx = { graph: { edges, nodes: [gen, ...sources] }, nodeOutputs: outputs, variables: {} };

        expect(referenceImageSourceIds(gen, ctx)).toStrictEqual(["ref", "pic"]);
        expect(mentionTargetsFor(gen, ctx, ["image"]).map((target) => [target.label, target.replacement])).toStrictEqual([
            ["Style", "image 1"],
            ["Frame", "image 2"],
        ]);
        expect(mentionTargetsFor(gen, ctx, ["text"]).map((target) => target.label)).toStrictEqual(["Note"]);
    });
});

describe("image-node prompts and reference images", () => {
    it("expands an image node's own prompt against the reference array it sends", () => {
        const sources = [node("pic", "image", { label: "Frame" }), node("blank", "image", { label: "Blank" }), node("ref", "style-ref", { label: "Style" })];
        const gen = node("gen", "image", { label: "Gen", mode: "generate", prompt: "blend @Style with @Frame" });
        const edges: WorkflowEdge[] = [
            { id: "e1", source: "ref", target: "gen" },
            { id: "e2", source: "blank", target: "gen" },
            { id: "e3", source: "pic", target: "gen" },
        ];
        const outputs = { blank: {}, pic: "https://x.example/p.png", ref: { imageUrl: "https://x.example/r.png" } };
        const ctx = { graph: { edges, nodes: [gen, ...sources] }, nodeOutputs: outputs, variables: {} };

        expect(referenceImageUrls(gen, ctx)).toStrictEqual(["https://x.example/r.png", "https://x.example/p.png"]);
        expect(referenceImageSourceIds(gen, ctx)).toStrictEqual(["ref", "pic"]);
        expect(expandNodeMentions(gen, gen.data.prompt as string, ctx)).toBe("blend image 1 with image 2");
    });

    it("references a generate-mode image node by the URL of its generated asset", () => {
        // generateImage answers `{ assets: [{ imageUrl }] }`; a mention of it must send that image.
        const hero = labelled("hero", "image", "Hero");
        const restyle = node("restyle", "image", { label: "Restyle", mode: "generate", prompt: "restyle @Hero" });
        const edges: WorkflowEdge[] = [{ id: "e1", source: "hero", target: "restyle" }];
        const ctx = {
            graph: { edges, nodes: [hero, restyle] },
            nodeOutputs: { hero: { assets: [{ imageSize: "1:1", imageUrl: "https://x.example/hero.png", mimeType: "image/png" }], modelId: "m", prompt: "p" } },
            variables: {},
        };

        expect(referenceImageUrls(restyle, ctx)).toStrictEqual(["https://x.example/hero.png"]);
        expect(expandNodeMentions(restyle, restyle.data.prompt as string, ctx)).toBe("restyle image 1");
    });

    it("sends at most four reference images, and numbers only the ones it sends", () => {
        const sources = ["a", "b", "c", "d", "e"].map((id) => labelled(id, "image", id.toUpperCase()));
        const gen = node("gen", "image", { mode: "generate" });
        const edges: WorkflowEdge[] = sources.map((source) => {
            return { id: `e-${source.id}`, source: source.id, target: "gen" };
        });
        const outputs = Object.fromEntries(sources.map((source) => [source.id, `https://x.example/${source.id}.png`]));
        const ctx = { graph: { edges, nodes: [gen, ...sources] }, nodeOutputs: outputs, variables: {} };

        expect(referenceImageSourceIds(gen, ctx)).toStrictEqual(["a", "b", "c", "d"]);
        expect(mentionTargetsFor(gen, ctx, ["image"]).map((target) => target.label)).toStrictEqual(["A", "B", "C", "D"]);
    });
});

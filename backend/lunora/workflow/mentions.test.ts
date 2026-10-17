import { REFERENCE_MEDIA_CAPS } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import type { MentionTarget, MentionableNode } from "./mentions";
import { expandTemplate, FRAME_KINDS, frameHandleId, MAX_WORKFLOW_REFERENCE_IMAGES, mentionableSources, parseFrameHandle, referenceImageIds } from "./mentions";

const noVariables = () => undefined;

const text = (id: string, label: string, replacement: string): MentionTarget => {
    return { id, kind: "text", label, replacement };
};

describe("expandTemplate", () => {
    it("replaces a mention with its target, labels with spaces and '#' included", () => {
        const result = expandTemplate("keep the framing of @Image #1 and @Notes", [text("a", "Image #1", "image 1"), text("b", "Notes", "x")], noVariables);

        expect(result).toBe("keep the framing of image 1 and x");
    });

    it("prefers the longest label, and never matches a label that is only a prefix of a longer word", () => {
        const targets = [text("one", "Image #1", "image 1"), text("ten", "Image #10", "image 10")];

        expect(expandTemplate("@Image #10", targets, noVariables)).toBe("image 10");
        expect(expandTemplate("@Image #12", targets, noVariables)).toBe("@Image #12");
    });

    it("leaves unknown mentions, and mentions glued to a word, as literal text", () => {
        const targets = [text("a", "Notes", "x")];

        expect(expandTemplate("ask @Nobody", targets, noVariables)).toBe("ask @Nobody");
        expect(expandTemplate("mail me@Notes", targets, noVariables)).toBe("mail me@Notes");
    });

    it("does not re-expand inserted output: an output containing a mention or a variable is copied verbatim", () => {
        const targets = [text("a", "Notes", "see @Other and {{secret}} $& end")];

        expect(expandTemplate("@Notes", targets, (name) => (name === "secret" ? "BAD" : undefined))).toBe("see @Other and {{secret}} $& end");
    });

    it("resolves variables in the same pass and keeps unresolved ones literal", () => {
        const result = expandTemplate("{{input}} then {{missing}} then @Notes", [text("a", "Notes", "x")], (name) => (name === "input" ? "hello" : undefined));

        expect(result).toBe("hello then {{missing}} then x");
    });
});

describe("frame handles", () => {
    it("round-trips every frame kind through its handle id, and rejects anything else", () => {
        for (const kind of FRAME_KINDS) {
            expect(parseFrameHandle(frameHandleId(kind))).toBe(kind);
        }

        expect(frameHandleId("end")).toBe("frame-end");
        expect(parseFrameHandle("frame-last")).toBeUndefined();
        expect(parseFrameHandle("output-0")).toBeUndefined();
        expect(parseFrameHandle(undefined)).toBeUndefined();
    });
});

describe("mentionableSources", () => {
    const labelled = (id: string, type: string, label: string): MentionableNode => {
        return { data: { label }, id, type };
    };
    const edgesTo = (target: string, ...sources: string[]) =>
        sources.map((source) => {
            return { source, target };
        });

    it("offers a unique upstream label by kind, and leaves a label shared by two upstream nodes out", () => {
        const nodes = [labelled("n", "text", "Notes"), labelled("s1", "ai", "Summary"), labelled("s2", "text", "Summary"), labelled("pic", "image", "Frame")];
        const candidates = mentionableSources(nodes, edgesTo("tpl", "n", "s1", "s2", "pic"), "tpl", ["text"]);

        expect(candidates).toStrictEqual([{ id: "n", kind: "text", label: "Notes" }]);
    });

    it("drops an output the caller reports as unavailable for that kind", () => {
        const nodes = [labelled("a", "text", "A"), labelled("b", "text", "B")];
        const candidates = mentionableSources(nodes, edgesTo("tpl", "a", "b"), "tpl", ["text"], (id) => id === "a");

        expect(candidates.map((candidate) => candidate.label)).toStrictEqual(["A"]);
    });

    it("numbers image candidates by referenceImageIds, which keeps only the first four available", () => {
        const sources = ["a", "b", "c", "d", "e"].map((id) => labelled(id, "image", id.toUpperCase()));
        const edges = edgesTo("gen", "a", "b", "c", "d", "e");

        expect(referenceImageIds(sources, edges, "gen")).toStrictEqual(["a", "b", "c", "d"]);
        expect(mentionableSources(sources, edges, "gen", ["image"]).map((candidate) => candidate.label)).toStrictEqual(["A", "B", "C", "D"]);
    });

    it("counts a labelled image node toward the cap even when its label is ambiguous", () => {
        // A duplicate label is not an error for a reference: the node is still sent, so it still takes a slot.
        const sources = [labelled("dup1", "image", "Same"), labelled("dup2", "image", "Same"), labelled("c", "image", "C")];
        const edges = edgesTo("gen", "dup1", "dup2", "c");

        expect(referenceImageIds(sources, edges, "gen")).toStrictEqual(["dup1", "dup2", "c"]);
        expect(mentionableSources(sources, edges, "gen", ["image"]).map((candidate) => candidate.id)).toStrictEqual(["c"]);
    });

    it("keeps MAX_WORKFLOW_REFERENCE_IMAGES equal to the registry's reference-image cap", () => {
        expect(MAX_WORKFLOW_REFERENCE_IMAGES).toBe(REFERENCE_MEDIA_CAPS.images);
    });
});

import { describe, expect, it } from "vitest";

import {
    buildMinimapItems,
    isProvisionalId,
    mergeOutline,
    MINIMAP_PREVIEW_CHARS,
    minimapGapLabel,
    promptsDropped,
    shouldShowMinimap,
    toMinimapPreview,
} from "./minimap-items";

describe("toMinimapPreview", () => {
    it("collapses whitespace and newlines to one line", () => {
        expect(toMinimapPreview("  first line\n\n  second\tline  ")).toBe("first line second line");
    });

    it("cuts long text with an ellipsis, keeping the limit", () => {
        const preview = toMinimapPreview("a".repeat(MINIMAP_PREVIEW_CHARS + 20));

        expect(preview).toHaveLength(MINIMAP_PREVIEW_CHARS);
        expect(preview.endsWith("…")).toBe(true);
    });

    it("keeps a markdown link's label and drops its target", () => {
        expect(toMinimapPreview("check and fix [pasted-text.txt](t3-context:abc123) please")).toBe("check and fix pasted-text.txt please");
    });

    it("leaves text at the limit untouched", () => {
        const exact = "b".repeat(MINIMAP_PREVIEW_CHARS);

        expect(toMinimapPreview(exact)).toBe(exact);
    });
});

describe("buildMinimapItems", () => {
    it("keeps only user prompts, in order", () => {
        const items = buildMinimapItems([
            { id: "u1", role: "user", text: "hello" },
            { id: "a1", role: "assistant", text: "hi there" },
            { id: "u2", role: "user", text: "tell me more" },
            { id: "t1", role: "tool", text: "result" },
        ]);

        expect(items).toEqual([
            { id: "u1", preview: "hello" },
            { id: "u2", preview: "tell me more" },
        ]);
    });

    it("gives an attachment-only prompt an empty preview", () => {
        expect(buildMinimapItems([{ id: "u1", role: "user", text: " ".repeat(3) }])).toEqual([{ id: "u1", preview: "" }]);
    });
});

describe("shouldShowMinimap", () => {
    const prompts = (count: number) =>
        buildMinimapItems(
            Array.from({ length: count }, (_, index) => {
                return { id: `u${index}`, role: "user", text: "x" };
            }),
        );

    it("is hidden below three prompts", () => {
        expect(shouldShowMinimap(prompts(0))).toBe(false);
        expect(shouldShowMinimap(prompts(2))).toBe(false);
    });

    it("shows from three prompts", () => {
        expect(shouldShowMinimap(prompts(3))).toBe(true);
    });
});

describe("mergeOutline", () => {
    const loaded = [
        { id: "p4", preview: "fourth" },
        { id: "p5", preview: "fifth" },
    ];

    it("lists the older prompts before the loaded ones, once each", () => {
        const outline = [
            { id: "p1", text: "first\nprompt" },
            { id: "p2", text: "second" },
            { id: "p3", text: "third" },
            { id: "p4", text: "fourth" },
        ];

        expect(mergeOutline(outline, loaded).map((item) => item.id)).toStrictEqual(["p1", "p2", "p3", "p4", "p5"]);
        expect(mergeOutline(outline, loaded)[0]?.preview).toBe("first prompt");
    });

    it("puts a prompt sent after the outline was read at the end", () => {
        expect(mergeOutline([{ id: "p1", text: "first" }], [{ id: "p1", preview: "first" }, ...loaded]).map((item) => item.id)).toStrictEqual([
            "p1",
            "p4",
            "p5",
        ]);
    });

    it("puts loaded prompts older than the outline's cut before it, not at the end", () => {
        const outline = [
            { id: "p3", text: "third" },
            { id: "p4", text: "fourth" },
        ];
        const window = [
            { id: "p1", preview: "first" },
            { id: "p2", preview: "second" },
            { id: "p3", preview: "third" },
            { id: "p4", preview: "fourth" },
            { id: "p5", preview: "fifth" },
        ];

        expect(mergeOutline(outline, window).map((item) => item.id)).toStrictEqual(["p1", "p2", "p3", "p4", "p5"]);
    });

    it("falls back to the loaded prompts until the outline arrives, or when it is empty", () => {
        expect(mergeOutline(undefined, loaded)).toStrictEqual(loaded);
        expect(mergeOutline([], loaded)).toStrictEqual(loaded);
    });

    it("lets the outline make a short loaded window show the rail", () => {
        const outline = Array.from({ length: 6 }, (_, index) => {
            return { id: `o${index}`, text: `prompt ${index}` };
        });

        expect(shouldShowMinimap([{ id: "x", preview: "only one loaded" }])).toBe(false);
        expect(shouldShowMinimap(mergeOutline(outline, [{ id: "x", preview: "only one loaded" }]))).toBe(true);
    });

    it("keeps the send time of a loaded prompt that the outline also lists", () => {
        const prompts = [
            { id: "p1", preview: "first", createdAt: 1000 },
            { id: "p2", preview: "second", createdAt: 2000 },
        ];
        const merged = mergeOutline(
            [
                { id: "p1", text: "first" },
                { id: "p2", text: "second" },
            ],
            prompts,
        );

        expect(merged.map((item) => item.createdAt)).toStrictEqual([1000, 2000]);
    });
});

describe("isProvisionalId", () => {
    it("marks the ids a sending prompt carries before its stored id", () => {
        expect(isProvisionalId("optimistic-1700000000")).toBe(true);
        expect(isProvisionalId("optimistic-edit-1700000000")).toBe(true);
        expect(isProvisionalId("transitioning-1700000000")).toBe(true);
        expect(isProvisionalId("m_abc123")).toBe(false);
    });
});

describe("promptsDropped", () => {
    it("is false when older pages load or a prompt is sent", () => {
        expect(promptsDropped(new Set(["p4", "p5"]), new Set(["p3", "p4", "p5"]))).toBe(false);
        expect(promptsDropped(new Set(["p4", "p5"]), new Set(["p4", "p5", "p6"]))).toBe(false);
    });

    it("is true when a branch switch, an edit or a delete replaces a loaded prompt", () => {
        expect(promptsDropped(new Set(["p4", "p5"]), new Set(["p4", "p5b"]))).toBe(true);
        expect(promptsDropped(new Set(["p4", "p5"]), new Set(["p4"]))).toBe(true);
    });

    it("has nothing to compare on the first read", () => {
        expect(promptsDropped(new Set(), new Set(["p1"]))).toBe(false);
    });
});

describe("minimapGapLabel", () => {
    const T0 = Date.UTC(2026, 9, 19, 9, 0);
    const HOUR = 60 * 60 * 1000;

    it("labels a gap of an hour or more in whole hours, and a day or more in days", () => {
        expect(minimapGapLabel(T0, T0 + 3 * HOUR + 20 * 60 * 1000)).toBe("3h");
        expect(minimapGapLabel(T0, T0 + 25 * HOUR)).toBe("1d");
    });

    it("has no label for a shorter gap, a first prompt, or a missing time", () => {
        expect(minimapGapLabel(T0, T0 + 59 * 60 * 1000)).toBeUndefined();
        expect(minimapGapLabel(undefined, T0)).toBeUndefined();
        expect(minimapGapLabel(T0, undefined)).toBeUndefined();
    });
});

describe("buildMinimapItems send times", () => {
    it("carries the creation time, and drops a missing or zero one", () => {
        const items = buildMinimapItems([
            { id: "u1", role: "user", text: "a", _creationTime: 1_700_000_000_000 },
            { id: "u2", role: "user", text: "b", _creationTime: 0 },
        ]);

        expect(items[0]?.createdAt).toBe(1_700_000_000_000);
        expect(items[1]?.createdAt).toBeUndefined();
    });
});

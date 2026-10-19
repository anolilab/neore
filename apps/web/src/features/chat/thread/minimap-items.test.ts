import { describe, expect, it } from "vitest";

import { buildMinimapItems, mergeOutline, MINIMAP_PREVIEW_CHARS, shouldShowMinimap, toMinimapPreview } from "./minimap-items";

describe("toMinimapPreview", () => {
    it("collapses whitespace and newlines to one line", () => {
        expect(toMinimapPreview("  first line\n\n  second\tline  ")).toBe("first line second line");
    });

    it("cuts long text with an ellipsis, keeping the limit", () => {
        const preview = toMinimapPreview("a".repeat(MINIMAP_PREVIEW_CHARS + 20));

        expect(preview).toHaveLength(MINIMAP_PREVIEW_CHARS);
        expect(preview.endsWith("…")).toBe(true);
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
});

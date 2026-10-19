import { describe, expect, it } from "vitest";

import { buildMinimapItems, MINIMAP_PREVIEW_CHARS, shouldShowMinimap, toMinimapPreview } from "./minimap-items";

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

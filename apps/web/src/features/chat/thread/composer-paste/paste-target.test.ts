// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKitExtension from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { takesPaste } from "./paste-target";

describe(takesPaste, () => {
    it("takes a paste while the composer is enabled and its editor editable", () => {
        const editor = new Editor({ extensions: [StarterKitExtension] });

        expect(takesPaste(false, editor)).toBe(true);
        expect(takesPaste(false, undefined)).toBe(true);

        editor.destroy();
    });

    it("refuses a paste once the composer is disabled or its editor read-only", () => {
        const editor = new Editor({ extensions: [StarterKitExtension] });

        expect(takesPaste(true, editor)).toBe(false);
        expect(takesPaste(true, undefined)).toBe(false);

        editor.setEditable(false);

        expect(takesPaste(false, editor)).toBe(false);

        editor.destroy();
    });
});

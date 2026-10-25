import { describe, expect, it } from "vitest";

import { isValidShortcut } from "./shortcut";

describe("isValidShortcut", () => {
    it.each(["ctrl+k", "ctrl+shift+m", "escape", "ctrl+/", "home", "end", "arrowdown", "ctrl+alt+f12", "?"])("accepts %s", (value) => {
        expect(isValidShortcut(value)).toBe(true);
    });

    it("accepts an empty string, which is a cleared binding", () => {
        expect(isValidShortcut("")).toBe(true);
    });

    it.each(["ctrl+", "ctrl+kk", "ctrl+<script>", "k+ctrl", " ", "ctrl+ k", 5, undefined, null])("rejects %s", (value) => {
        expect(isValidShortcut(value)).toBe(false);
    });
});

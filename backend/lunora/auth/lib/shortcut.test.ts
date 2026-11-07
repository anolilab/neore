import { describe, expect, it } from "vitest";

import { isFocusAreaShortcut, isValidShortcut, withoutFocusAreaKeys } from "./shortcut";

describe("isValidShortcut", () => {
    it.each(["ctrl+k", "ctrl+shift+m", "escape", "ctrl+/", "home", "end", "arrowdown", "ctrl+alt+f12", "?", "ctrl+f6", "shift+f5"])("accepts %s", (value) => {
        expect(isValidShortcut(value)).toBe(true);
    });

    it("accepts an empty string, which is a cleared binding", () => {
        expect(isValidShortcut("")).toBe(true);
    });

    it.each(["ctrl+", "ctrl+kk", "ctrl+<script>", "k+ctrl", " ", "ctrl+ k", 5, undefined, null])("rejects %s", (value) => {
        expect(isValidShortcut(value)).toBe(false);
    });

    it.each(["f6", "F6", "shift+f6", "Shift+F6"])("rejects %s, which moves focus between screen areas", (value) => {
        expect(isValidShortcut(value)).toBe(false);
    });
});

describe("focus-area keys", () => {
    it("matches F6 and Shift+F6 only, with no other modifier", () => {
        expect(isFocusAreaShortcut("f6")).toBe(true);
        expect(isFocusAreaShortcut("shift+f6")).toBe(true);
        expect(isFocusAreaShortcut("ctrl+f6")).toBe(false);
        expect(isFocusAreaShortcut("f5")).toBe(false);
    });

    it("clears those bindings and keeps the rest", () => {
        expect(withoutFocusAreaKeys({ escape: "", help: "f6", newChat: "Shift+F6", sidebarLeft: "ctrl+b" })).toEqual({
            escape: "",
            help: "",
            newChat: "",
            sidebarLeft: "ctrl+b",
        });
    });
});

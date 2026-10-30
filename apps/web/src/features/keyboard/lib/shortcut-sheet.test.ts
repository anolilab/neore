import { describe, expect, it } from "vitest";

import { defaultKeyboardShortcuts } from "@/features/layout/stores/ui-state-store";

import { matchesShortcutQuery, resolveShortcuts, shortcutToKeys } from "./shortcut-sheet";

describe("shortcutToKeys", () => {
    it("uses symbols on a Mac", () => {
        expect(shortcutToKeys("ctrl+shift+f", true)).toEqual(["⌘", "⇧", "F"]);
        expect(shortcutToKeys("alt+shift+k", true)).toEqual(["⌥", "⇧", "K"]);
    });

    it("spells modifiers out elsewhere", () => {
        expect(shortcutToKeys("ctrl+shift+f", false)).toEqual(["Ctrl", "Shift", "F"]);
        expect(shortcutToKeys("shift+alt+k", false)).toEqual(["Alt", "Shift", "K"]);
    });

    it("names special keys and keeps the slash", () => {
        expect(shortcutToKeys("ctrl+/", false)).toEqual(["Ctrl", "/"]);
        expect(shortcutToKeys("escape", false)).toEqual(["Esc"]);
        expect(shortcutToKeys("arrowup+arrowdown", false)).toEqual(["↑", "↓"]);
    });

    it("reads a trailing plus as the plus key", () => {
        expect(shortcutToKeys("ctrl++", false)).toEqual(["Ctrl", "+"]);
    });

    it("returns nothing for an unbound chord", () => {
        expect(shortcutToKeys(undefined, true)).toEqual([]);
        expect(shortcutToKeys("", true)).toEqual([]);
    });
});

describe("resolveShortcuts", () => {
    it("shows a rebound key and the new find and search chords", () => {
        const resolved = resolveShortcuts({ ...defaultKeyboardShortcuts, newChat: "alt+n" }, false);
        const keysOf = (id: string) => resolved.find((item) => item.entry.id === id)?.keys;

        expect(keysOf("newChat")).toEqual(["Alt", "N"]);
        expect(keysOf("findInThread")).toEqual(["Ctrl", "F"]);
        expect(keysOf("focusSearch")).toEqual(["Ctrl", "Shift", "F"]);
    });

    it("leaves out actions that are unbound", () => {
        const resolved = resolveShortcuts(defaultKeyboardShortcuts, false);

        expect(resolved.some((item) => item.entry.id === "increaseEffort")).toBe(false);
        expect(resolved.some((item) => item.entry.id === "listOpen")).toBe(true);
    });
});

describe("matchesShortcutQuery", () => {
    it("matches label, group and keys", () => {
        expect(matchesShortcutQuery("find", "Find in thread", "Chat", ["Ctrl", "F"])).toBe(true);
        expect(matchesShortcutQuery("chat", "Find in thread", "Chat", ["Ctrl", "F"])).toBe(true);
        expect(matchesShortcutQuery("ctrl+f", "Find in thread", "Chat", ["Ctrl", "F"])).toBe(true);
        expect(matchesShortcutQuery("zzz", "Find in thread", "Chat", ["Ctrl", "F"])).toBe(false);
        expect(matchesShortcutQuery("  ", "Find in thread", "Chat", [])).toBe(true);
    });
});

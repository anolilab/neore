import { describe, expect, it } from "vitest";

import {
    eventToShortcut,
    formatShortcut,
    formatShortcutForDisplay,
    getModifierCombinations,
    isValidShortcut,
    matchesShortcut,
    parseShortcut,
} from "./keyboard-shortcuts";

const createKeyEvent = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({
        altKey: false,
        ctrlKey: false,
        key: "",
        metaKey: false,
        shiftKey: false,
        ...overrides,
    }) as KeyboardEvent;

describe("parseShortcut", () => {
    it("should parse simple modifier + key", () => {
        expect(parseShortcut("Ctrl+B")).toEqual({ key: "B", modifiers: ["Ctrl"] });
    });

    it("should parse multiple modifiers", () => {
        expect(parseShortcut("Ctrl+Shift+K")).toEqual({ key: "K", modifiers: ["Ctrl", "Shift"] });
    });

    it("should parse Cmd modifier", () => {
        expect(parseShortcut("Cmd+S")).toEqual({ key: "S", modifiers: ["Cmd"] });
    });

    it("should parse Alt modifier", () => {
        expect(parseShortcut("Alt+F4")).toEqual({ key: "F4", modifiers: ["Alt"] });
    });

    it("should handle case-insensitive modifiers", () => {
        expect(parseShortcut("ctrl+b")).toEqual({ key: "b", modifiers: ["Ctrl"] });
        expect(parseShortcut("SHIFT+A")).toEqual({ key: "A", modifiers: ["Shift"] });
    });

    it("should treat 'meta' as Cmd", () => {
        expect(parseShortcut("meta+Z")).toEqual({ key: "Z", modifiers: ["Cmd"] });
    });

    it("should treat 'command' as Cmd", () => {
        expect(parseShortcut("command+C")).toEqual({ key: "C", modifiers: ["Cmd"] });
    });

    it("should treat 'option' as Alt", () => {
        expect(parseShortcut("option+D")).toEqual({ key: "D", modifiers: ["Alt"] });
    });

    it("should treat 'control' as Ctrl", () => {
        expect(parseShortcut("control+X")).toEqual({ key: "X", modifiers: ["Ctrl"] });
    });

    it("should return null for empty input", () => {
        expect(parseShortcut("")).toBeNull();
    });

    it("should return null for modifiers-only (no key)", () => {
        expect(parseShortcut("Ctrl+Shift")).toBeNull();
    });

    it("should return null for non-string input", () => {
        expect(parseShortcut(null as any)).toBeNull();
        expect(parseShortcut(undefined as any)).toBeNull();
    });

    it("should handle spaces in parts", () => {
        expect(parseShortcut("Ctrl + B")).toEqual({ key: "B", modifiers: ["Ctrl"] });
    });
});

describe("matchesShortcut", () => {
    it("should match Ctrl+B", () => {
        const event = createKeyEvent({ ctrlKey: true, key: "b" });

        expect(matchesShortcut(event, "Ctrl+B")).toBe(true);
    });

    it("should match metaKey for Ctrl shortcut", () => {
        const event = createKeyEvent({ key: "s", metaKey: true });

        expect(matchesShortcut(event, "Ctrl+S")).toBe(true);
    });

    it("should match Ctrl+Shift+K", () => {
        const event = createKeyEvent({ ctrlKey: true, key: "k", shiftKey: true });

        expect(matchesShortcut(event, "Ctrl+Shift+K")).toBe(true);
    });

    it("should not match when extra modifier pressed", () => {
        const event = createKeyEvent({ altKey: true, ctrlKey: true, key: "b" });

        expect(matchesShortcut(event, "Ctrl+B")).toBe(false);
    });

    it("should not match wrong key", () => {
        const event = createKeyEvent({ ctrlKey: true, key: "c" });

        expect(matchesShortcut(event, "Ctrl+B")).toBe(false);
    });

    it("should return false for invalid shortcut", () => {
        const event = createKeyEvent({ key: "b" });

        expect(matchesShortcut(event, "")).toBe(false);
    });

    it("should handle Escape key matching", () => {
        const event = createKeyEvent({ ctrlKey: true, key: "Escape" });

        expect(matchesShortcut(event, "Ctrl+Escape")).toBe(true);
    });
});

describe("formatShortcut", () => {
    it("should format key combination as string", () => {
        expect(formatShortcut({ key: "B", modifiers: ["Ctrl"] })).toBe("Ctrl+B");
    });

    it("should format multiple modifiers", () => {
        expect(formatShortcut({ key: "K", modifiers: ["Ctrl", "Shift"] })).toBe("Ctrl+Shift+K");
    });

    it("should handle no modifiers", () => {
        expect(formatShortcut({ key: "Escape", modifiers: [] })).toBe("Escape");
    });
});

describe("formatShortcutForDisplay", () => {
    it("should return empty string for empty input", () => {
        expect(formatShortcutForDisplay("")).toBe("");
    });

    it("should format Cmd as ⌘", () => {
        expect(formatShortcutForDisplay("Cmd+S")).toBe("⌘ + S");
    });

    it("should format arrow keys", () => {
        expect(formatShortcutForDisplay("ArrowUp")).toBe("↑");
        expect(formatShortcutForDisplay("ArrowDown")).toBe("↓");
        expect(formatShortcutForDisplay("ArrowLeft")).toBe("←");
        expect(formatShortcutForDisplay("ArrowRight")).toBe("→");
    });

    it("should format special keys", () => {
        expect(formatShortcutForDisplay("Escape")).toBe("Esc");
        expect(formatShortcutForDisplay("Backspace")).toBe("⌫");
        expect(formatShortcutForDisplay("Delete")).toBe("Del");
        expect(formatShortcutForDisplay("PageUp")).toBe("PgUp");
        expect(formatShortcutForDisplay("PageDown")).toBe("PgDn");
    });

    it("should capitalize single character keys", () => {
        expect(formatShortcutForDisplay("Cmd+b")).toBe("⌘ + B");
    });
});

describe("eventToShortcut", () => {
    it("should convert Ctrl+key to ctrl+key format", () => {
        const event = createKeyEvent({ ctrlKey: true, key: "b" });

        expect(eventToShortcut(event)).toBe("ctrl+b");
    });

    it("should convert metaKey to ctrl for storage", () => {
        const event = createKeyEvent({ key: "s", metaKey: true });

        expect(eventToShortcut(event)).toBe("ctrl+s");
    });

    it("should include alt modifier", () => {
        const event = createKeyEvent({ altKey: true, key: "f" });

        expect(eventToShortcut(event)).toBe("alt+f");
    });

    it("should include shift modifier", () => {
        const event = createKeyEvent({ ctrlKey: true, key: "k", shiftKey: true });

        expect(eventToShortcut(event)).toBe("ctrl+shift+k");
    });

    it("should return single letter without modifiers as lowercase", () => {
        const event = createKeyEvent({ key: "a" });

        expect(eventToShortcut(event)).toBe("a");
    });

    it("should normalize Space key", () => {
        const event = createKeyEvent({ ctrlKey: true, key: " " });

        expect(eventToShortcut(event)).toBe("ctrl+space");
    });
});

describe("isValidShortcut", () => {
    it("should return true for valid shortcuts", () => {
        expect(isValidShortcut("Ctrl+B")).toBe(true);
        expect(isValidShortcut("Cmd+Shift+K")).toBe(true);
        expect(isValidShortcut("Alt+F4")).toBe(true);
    });

    it("should return false for invalid shortcuts", () => {
        expect(isValidShortcut("")).toBe(false);
        expect(isValidShortcut("Ctrl+Shift")).toBe(false);
    });
});

describe("getModifierCombinations", () => {
    it("should generate combinations for a key", () => {
        const combos = getModifierCombinations("B");

        expect(combos.length).toBeGreaterThan(0);

        // Should include single modifiers
        expect(combos).toContain("ctrl+B");
        expect(combos).toContain("alt+B");
        expect(combos).toContain("shift+B");

        // Should include multi-modifier combos
        expect(combos).toContain("ctrl+alt+B");
        expect(combos).toContain("ctrl+shift+B");
        expect(combos).toContain("alt+shift+B");
        expect(combos).toContain("ctrl+alt+shift+B");
    });

    it("should not include bare key (no modifiers)", () => {
        const combos = getModifierCombinations("X");

        expect(combos).not.toContain("X");
    });

    it("should return 7 combinations (2^3 - 1)", () => {
        const combos = getModifierCombinations("Z");

        expect(combos).toHaveLength(7);
    });
});

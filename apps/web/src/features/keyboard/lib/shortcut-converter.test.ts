import { describe, expect, it } from "vitest";

import convertShortcutToHotkeysHook from "./shortcut-converter";

describe("convertShortcutToHotkeysHook", () => {
    describe("modifier conversions", () => {
        it("should convert 'cmd' to 'meta'", () => {
            expect(convertShortcutToHotkeysHook("cmd+k")).toBe("meta+k");
        });

        it("should convert 'command' to 'meta'", () => {
            expect(convertShortcutToHotkeysHook("command+k")).toBe("meta+k");
        });

        it("should preserve 'ctrl'", () => {
            expect(convertShortcutToHotkeysHook("ctrl+k")).toBe("ctrl+k");
        });

        it("should preserve 'shift'", () => {
            expect(convertShortcutToHotkeysHook("shift+a")).toBe("shift+a");
        });

        it("should preserve 'alt'", () => {
            expect(convertShortcutToHotkeysHook("alt+tab")).toBe("alt+tab");
        });

        it("should handle multiple modifiers with cmd", () => {
            expect(convertShortcutToHotkeysHook("cmd+shift+r")).toBe("meta+shift+r");
        });

        it("should handle case-insensitive input", () => {
            expect(convertShortcutToHotkeysHook("CMD+K")).toBe("meta+k");
            expect(convertShortcutToHotkeysHook("Ctrl+Shift+A")).toBe("ctrl+shift+a");
        });
    });

    describe("special key conversions", () => {
        it("should convert 'escape' to 'esc'", () => {
            expect(convertShortcutToHotkeysHook("escape")).toBe("esc");
        });

        it("should preserve arrow keys", () => {
            expect(convertShortcutToHotkeysHook("arrowdown")).toBe("arrowdown");
            expect(convertShortcutToHotkeysHook("arrowup")).toBe("arrowup");
            expect(convertShortcutToHotkeysHook("arrowleft")).toBe("arrowleft");
            expect(convertShortcutToHotkeysHook("arrowright")).toBe("arrowright");
        });

        it("should handle modifier + escape", () => {
            expect(convertShortcutToHotkeysHook("ctrl+escape")).toBe("ctrl+esc");
        });

        it("should handle modifier + arrow key", () => {
            expect(convertShortcutToHotkeysHook("cmd+arrowdown")).toBe("meta+arrowdown");
        });
    });

    describe("edge cases", () => {
        it("should return fallback for undefined", () => {
            const result = convertShortcutToHotkeysHook(undefined);

            expect(result).toBe("f24+shift+alt+ctrl");
        });

        it("should return fallback for empty string", () => {
            expect(convertShortcutToHotkeysHook("")).toBe("f24+shift+alt+ctrl");
        });

        it("should return fallback for whitespace-only string", () => {
            expect(convertShortcutToHotkeysHook(" ".repeat(3))).toBe("f24+shift+alt+ctrl");
        });

        it("should handle single keys without modifiers", () => {
            expect(convertShortcutToHotkeysHook("k")).toBe("k");
            expect(convertShortcutToHotkeysHook("enter")).toBe("enter");
        });
    });
});

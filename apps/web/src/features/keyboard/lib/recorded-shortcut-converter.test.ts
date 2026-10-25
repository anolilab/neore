import { describe, expect, it } from "vitest";

import { convertRecordedShortcutToHotkeysHook } from "./recorded-shortcut-converter";
import convertShortcutToHotkeysHook from "./shortcut-converter";

describe("convertRecordedShortcutToHotkeysHook", () => {
    it("answers to Command as well as Control on a Mac", () => {
        expect(convertRecordedShortcutToHotkeysHook("ctrl+alt+arrowup", "cmd")).toBe("ctrl+alt+arrowup,meta+alt+arrowup");
    });

    it("leaves a Control chord alone elsewhere", () => {
        expect(convertRecordedShortcutToHotkeysHook("ctrl+alt+arrowup", "ctrl")).toBe("ctrl+alt+arrowup");
    });

    it("leaves a chord without Control, and an unbound command, as the plain conversion", () => {
        expect(convertRecordedShortcutToHotkeysHook("alt+arrowup", "cmd")).toBe("alt+arrowup");
        expect(convertRecordedShortcutToHotkeysHook("", "cmd")).toBe(convertShortcutToHotkeysHook(""));
        expect(convertRecordedShortcutToHotkeysHook(undefined, "cmd")).toBe(convertShortcutToHotkeysHook(undefined));
    });
});

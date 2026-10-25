import { describe, expect, it } from "vitest";

import { convertRecordedShortcutToHotkeysHook, effortCommandsToRegister, findEffortConflicts } from "./recorded-shortcut-converter";
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

describe("findEffortConflicts", () => {
    it("finds nothing while the effort commands are unbound or on free chords", () => {
        expect(findEffortConflicts({ newChat: "cmd+n" }, "cmd")).toStrictEqual({});
        expect(findEffortConflicts({ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+arrowup", newChat: "cmd+n" }, "cmd")).toStrictEqual({});
        expect(findEffortConflicts({ decreaseEffort: "", increaseEffort: "", newChat: "" }, "cmd")).toStrictEqual({});
    });

    it("flags both effort commands on the same chord, however its modifiers are ordered", () => {
        expect(findEffortConflicts({ decreaseEffort: "ctrl+shift+e", increaseEffort: "shift+ctrl+e" }, "ctrl")).toStrictEqual({
            decreaseEffort: "effort",
            increaseEffort: "effort",
        });
    });

    it("flags a Control chord and its Command twin on a Mac, where one Command press would run both", () => {
        expect(findEffortConflicts({ decreaseEffort: "ctrl+e", increaseEffort: "cmd+e" }, "cmd")).toStrictEqual({
            decreaseEffort: "effort",
            increaseEffort: "effort",
        });
        expect(findEffortConflicts({ decreaseEffort: "ctrl+e", increaseEffort: "cmd+e" }, "ctrl")).toStrictEqual({});
    });

    it("flags an effort chord another command has registered", () => {
        expect(findEffortConflicts({ increaseEffort: "ctrl+n", newChat: "ctrl+n" }, "ctrl")).toStrictEqual({ increaseEffort: "command" });
        expect(findEffortConflicts({ decreaseEffort: "ctrl+shift+n", newTemporaryChat: "shift+ctrl+n" }, "ctrl")).toStrictEqual({ decreaseEffort: "command" });
    });

    it("sees a recorded Control chord collide with the Command default on a Mac only", () => {
        expect(findEffortConflicts({ increaseEffort: "ctrl+n", newChat: "cmd+n" }, "cmd")).toStrictEqual({ increaseEffort: "command" });
        expect(findEffortConflicts({ increaseEffort: "ctrl+n", newChat: "cmd+n" }, "ctrl")).toStrictEqual({});
    });
});

describe("effortCommandsToRegister", () => {
    it("registers only the bound commands", () => {
        expect(effortCommandsToRegister({ decreaseEffort: "", newChat: "ctrl+n" }, "ctrl")).toStrictEqual({ decreaseEffort: false, increaseEffort: false });
        expect(effortCommandsToRegister({ increaseEffort: "alt+arrowup" }, "ctrl")).toStrictEqual({ decreaseEffort: false, increaseEffort: true });
    });

    it("lets decrease keep a chord both effort commands hold, and another command keep its own", () => {
        expect(effortCommandsToRegister({ decreaseEffort: "alt+e", increaseEffort: "alt+e" }, "ctrl")).toStrictEqual({
            decreaseEffort: true,
            increaseEffort: false,
        });
        expect(effortCommandsToRegister({ decreaseEffort: "ctrl+n", increaseEffort: "alt+e", newChat: "ctrl+n" }, "ctrl")).toStrictEqual({
            decreaseEffort: false,
            increaseEffort: true,
        });
    });
});

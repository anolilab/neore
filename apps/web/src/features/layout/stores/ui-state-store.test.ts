import { describe, expect, it } from "vitest";

import { defaultKeyboardShortcuts, mergeKeyboardShortcuts, useUIStateStore } from "./ui-state-store";

describe("default keyboard shortcuts", () => {
    it("carry no binding that nothing registers", () => {
        for (const key of ["createBranch", "pinThread", "search"]) {
            expect(defaultKeyboardShortcuts).not.toHaveProperty(key);
        }
    });
});

describe("find in thread shortcut", () => {
    const oldFocusSearch = defaultKeyboardShortcuts.findInThread;

    it("gives Find the browser-find chord and Focus Search the shifted one", () => {
        expect(defaultKeyboardShortcuts.findInThread.endsWith("+f")).toBe(true);
        expect(defaultKeyboardShortcuts.focusSearch).toBe(`${defaultKeyboardShortcuts.findInThread.slice(0, -2)}+shift+f`);
    });

    it("moves a Focus Search still on the old default when Find was never saved", () => {
        expect(mergeKeyboardShortcuts({ focusSearch: oldFocusSearch }).focusSearch).toBe(defaultKeyboardShortcuts.focusSearch);
        expect(mergeKeyboardShortcuts({ focusSearch: oldFocusSearch }).findInThread).toBe(oldFocusSearch);
    });

    it("keeps a customised Focus Search", () => {
        expect(mergeKeyboardShortcuts({ focusSearch: "ctrl+j" }).focusSearch).toBe("ctrl+j");
    });

    it("keeps Focus Search when Find is already saved", () => {
        expect(mergeKeyboardShortcuts({ findInThread: "ctrl+g", focusSearch: oldFocusSearch }).focusSearch).toBe(oldFocusSearch);
    });

    it("leaves Find unbound for a user who unbound Focus Search", () => {
        expect(mergeKeyboardShortcuts({ focusSearch: "" }).findInThread).toBe("");
        expect(mergeKeyboardShortcuts({ findInThread: "ctrl+g", focusSearch: "" }).findInThread).toBe("ctrl+g");
    });

    it("fills every default for nothing saved", () => {
        expect(mergeKeyboardShortcuts(undefined)).toEqual(defaultKeyboardShortcuts);
    });
});

describe("focus-area keys", () => {
    it("clears a saved binding on F6 or Shift+F6, so it cannot run beside focus navigation", () => {
        const merged = mergeKeyboardShortcuts({ help: "f6", newChat: "Shift+F6", newTemporaryChat: "ctrl+f6" });

        expect(merged.help).toBe("");
        expect(merged.newChat).toBe("");
        expect(merged.newTemporaryChat).toBe("ctrl+f6");
    });

    it("refuses a binding on F6 when one is set in the store", () => {
        useUIStateStore.getState().setKeyboardShortcuts({ help: "f6" });

        expect(useUIStateStore.getState().keyboardShortcuts.help).toBe("");
    });
});

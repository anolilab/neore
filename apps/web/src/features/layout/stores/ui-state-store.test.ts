import { describe, expect, it } from "vitest";

import { defaultKeyboardShortcuts, mergeKeyboardShortcuts, useUIStateStore } from "./ui-state-store";

describe("default keyboard shortcuts", () => {
    it("carry no binding that nothing registers", () => {
        for (const key of ["createBranch", "pinThread", "search"]) {
            expect(defaultKeyboardShortcuts).not.toHaveProperty(key);
        }
    });
});

describe("thread action defaults against saved bindings", () => {
    it("leaves archive unbound when a saved binding already takes its chord, and keeps that binding", () => {
        const merged = mergeKeyboardShortcuts({ newChat: defaultKeyboardShortcuts.archiveThread });

        expect(merged.archiveThread).toBe("");
        expect(merged.newChat).toBe(defaultKeyboardShortcuts.archiveThread);
    });

    it("leaves delete unbound on the same collision", () => {
        expect(mergeKeyboardShortcuts({ newChat: defaultKeyboardShortcuts.deleteThread }).deleteThread).toBe("");
    });

    it("keeps the default when no saved binding takes its chord", () => {
        expect(mergeKeyboardShortcuts({ newChat: "ctrl+j" }).archiveThread).toBe(defaultKeyboardShortcuts.archiveThread);
    });

    it("reads the thread actions' old defaults in a set saved before they were removed as unset, so the new defaults apply", () => {
        const merged = mergeKeyboardShortcuts({ archiveThread: "ctrl+a", deleteThread: "ctrl+d" });

        expect(merged.archiveThread).toBe(defaultKeyboardShortcuts.archiveThread);
        expect(merged.deleteThread).toBe(defaultKeyboardShortcuts.deleteThread);
    });

    it("keeps a binding the user saved for the thread action itself", () => {
        expect(mergeKeyboardShortcuts({ archiveThread: "ctrl+j" }).archiveThread).toBe("ctrl+j");
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

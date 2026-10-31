import { describe, expect, it } from "vitest";

import { defaultKeyboardShortcuts, mergeKeyboardShortcuts } from "./ui-state-store";

describe("default keyboard shortcuts", () => {
    it("carry no binding that nothing registers", () => {
        for (const key of ["archiveThread", "createBranch", "deleteThread", "pinThread", "search"]) {
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

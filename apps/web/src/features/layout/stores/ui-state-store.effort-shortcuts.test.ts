import { afterEach, describe, expect, it } from "vitest";

import { useUIStateStore } from "./ui-state-store";

afterEach(() => {
    useUIStateStore.getState().resetKeyboardShortcuts();
});

describe("effort shortcuts in the keyboard registry", () => {
    it("are unbound by default", () => {
        const { keyboardShortcuts } = useUIStateStore.getState();

        expect(keyboardShortcuts.increaseEffort).toBeUndefined();
        expect(keyboardShortcuts.decreaseEffort).toBeUndefined();
    });

    it("are unbound again after the user resets the shortcuts", () => {
        useUIStateStore.getState().setKeyboardShortcuts({ decreaseEffort: "alt+arrowdown", increaseEffort: "alt+arrowup" });
        useUIStateStore.getState().resetKeyboardShortcuts();

        const { keyboardShortcuts } = useUIStateStore.getState();

        expect(keyboardShortcuts.increaseEffort).toBeUndefined();
        expect(keyboardShortcuts.decreaseEffort).toBeUndefined();
    });
});

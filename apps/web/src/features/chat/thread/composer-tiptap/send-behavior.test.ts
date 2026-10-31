import { describe, expect, it } from "vitest";

import { resolveEnterAction, sendShortcutLabel } from "./send-behavior";

describe(resolveEnterAction, () => {
    it("enter: Enter sends, Shift+Enter breaks the line", () => {
        expect(resolveEnterAction("enter", "plain")).toBe("send");
        expect(resolveEnterAction("enter", "shift")).toBe("newline");
    });

    it("shiftEnter: Shift+Enter sends, Enter breaks the line", () => {
        expect(resolveEnterAction("shiftEnter", "shift")).toBe("send");
        expect(resolveEnterAction("shiftEnter", "plain")).toBe("newline");
    });

    it("button: both Enter chords break the line", () => {
        expect(resolveEnterAction("button", "plain")).toBe("newline");
        expect(resolveEnterAction("button", "shift")).toBe("newline");
    });

    it.each(["enter", "shiftEnter", "button"] as const)("%s: Cmd/Ctrl+Enter sends", (behavior) => {
        expect(resolveEnterAction(behavior, "mod")).toBe("send");
    });
});

describe(sendShortcutLabel, () => {
    it("names the chord, or nothing in button mode", () => {
        expect(sendShortcutLabel("enter")).toBe("Enter");
        expect(sendShortcutLabel("shiftEnter")).toBe("Shift+Enter");
        expect(sendShortcutLabel("button")).toBeUndefined();
    });
});

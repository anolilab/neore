import { describe, expect, it } from "vitest";

import { canHideSplash } from "./splash-gate";

describe("canHideSplash", () => {
    it("holds while the session is not known", () => {
        expect(canHideSplash({ isListReady: true, isOnList: true, status: "loading" })).toBe(false);
    });

    it("holds a signed-in launch on the chat list until its saved rows are read", () => {
        expect(canHideSplash({ isListReady: false, isOnList: true, status: "signed-in" })).toBe(false);
        expect(canHideSplash({ isListReady: true, isOnList: true, status: "signed-in" })).toBe(true);
    });

    it("lets a signed-out launch or another first screen show at once", () => {
        expect(canHideSplash({ isListReady: false, isOnList: true, status: "signed-out" })).toBe(true);
        expect(canHideSplash({ isListReady: false, isOnList: false, status: "signed-in" })).toBe(true);
    });
});

import { describe, expect, it } from "vitest";

import { loginItemMenuState, supportsLoginItem } from "./login-item.js";

describe("loginItemMenuState", () => {
    it("is enabled and reflects the OS setting in a packaged macOS or Windows build", () => {
        expect(loginItemMenuState({ isPackaged: true, openAtLogin: true, platform: "darwin" })).toStrictEqual({ checked: true, enabled: true });
        expect(loginItemMenuState({ isPackaged: true, openAtLogin: false, platform: "win32" })).toStrictEqual({ checked: false, enabled: true });
    });

    it("is disabled and unchecked in an unpackaged (dev) run, whatever the OS says", () => {
        expect(loginItemMenuState({ isPackaged: false, openAtLogin: true, platform: "darwin" })).toStrictEqual({ checked: false, enabled: false });
    });

    it("is disabled on Linux, where there is no login item", () => {
        expect(loginItemMenuState({ isPackaged: true, openAtLogin: true, platform: "linux" })).toStrictEqual({ checked: false, enabled: false });
        expect(supportsLoginItem("linux")).toBe(false);
    });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accentHex, DARK_BACKGROUND, LIGHT_BACKGROUND, readAppearance, windowBackground, writeAppearance } from "./appearance.js";

describe(accentHex, () => {
    it.each([
        ["0a84ffff", "#0a84ff"],
        ["FF453AFF", "#ff453a"],
        ["#00aaff", "#00aaff"],
        [" 112233ff ", "#112233"],
    ])("turns %s into %s", (raw, hex) => {
        expect(accentHex(raw)).toBe(hex);
    });

    it.each([[""], ["fff"], ["0a84ffff00"], ["zzzzzzzz"], [false], [undefined]])("refuses %s", (raw) => {
        expect(accentHex(raw)).toBeNull();
    });
});

describe(windowBackground, () => {
    it("follows the theme", () => {
        expect(windowBackground({ dark: true, vibrancy: false })).toBe(DARK_BACKGROUND);
        expect(windowBackground({ dark: false, vibrancy: false })).toBe(LIGHT_BACKGROUND);
    });
});

describe(readAppearance, () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories) {
            rmSync(directory, { force: true, recursive: true });
        }

        directories.length = 0;
    });

    it("reads back what was written, and is undefined for no file or a torn one", () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), "neore-appearance-"));

        directories.push(directory);
        const file = path.join(directory, "appearance.json");

        expect(readAppearance(file)).toBeUndefined();
        writeAppearance(file, { dark: true });
        expect(readAppearance(file)).toStrictEqual({ dark: true });
        writeFileSync(file, `{"dark":`);
        expect(readAppearance(file)).toBeUndefined();
        writeFileSync(file, `{"dark":"yes"}`);
        expect(readAppearance(file)).toBeUndefined();
    });
});

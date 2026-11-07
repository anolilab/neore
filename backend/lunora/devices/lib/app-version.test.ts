import { describe, expect, it } from "vitest";

import { isAppVersion } from "./app-version";
import { MAX_APP_VERSION_LENGTH } from "./constants";

describe("isAppVersion", () => {
    it("accepts dotted numbers with an optional pre-release tag", () => {
        for (const good of ["1", "1.2", "1.2.3", ["1", "2", "3", "4"].join("."), "1.2.3-beta.1"]) {
            expect(isAppVersion(good)).toBe(true);
        }
    });

    it("refuses what is not a version", () => {
        for (const bad of [
            "",
            "v1.2.3",
            "1.2.3+build",
            "latest",
            "1..2",
            "1.2.3.4.5",
            "1.2.x",
            "<script>",
            "1.2.3\n",
            "1.2.3-beta.",
            "1.2.3-beta..1",
            "1.2.3-beta-",
        ]) {
            expect(isAppVersion(bad)).toBe(false);
        }
    });

    it("accepts a long numeric component, as the desktop release tags do", () => {
        expect(isAppVersion("1234567890.1.2")).toBe(true);
    });

    it("refuses a version longer than the cap", () => {
        expect(isAppVersion(`1.0-${"a".repeat(MAX_APP_VERSION_LENGTH)}`)).toBe(false);
    });
});

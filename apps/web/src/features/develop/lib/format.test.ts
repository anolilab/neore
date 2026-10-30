import { describe, expect, it } from "vitest";

import { commitSubject, safeExternalUrl, shortSha } from "./format";

describe("develop formatting", () => {
    it("takes the subject line of a commit message", () => {
        expect(commitSubject("Fix it\n\nLong body")).toBe("Fix it");
        expect(commitSubject("")).toBe("");
    });

    it("shortens a commit id to seven characters", () => {
        expect(shortSha("a1b2c3d4e5f60718")).toBe("a1b2c3d");
    });

    it.each([
        ["https://example.com/a", "https://example.com/a"],
        [["http", "://example.com/a"].join(""), undefined],
        [["java", "script:alert(1)"].join(""), undefined],
        ["data:text/html,<script>", undefined],
        ["not a url", undefined],
        ["", undefined],
        [null, undefined],
    ])("keeps %j as %j", (url, expected) => {
        expect(safeExternalUrl(url)).toBe(expected);
    });
});

import { describe, expect, it } from "vitest";

import { refusesToolConfig } from "./install-action";

describe("a plugin skill's tool config", () => {
    it("refuses a skill that adds tools", () => {
        expect(refusesToolConfig({ additionalTools: ["web_search"] })).toBe(true);
    });

    it("refuses a skill that removes tools", () => {
        expect(refusesToolConfig({ disabledTools: ["fs_write"] })).toBe(true);
    });

    it("allows a skill with empty tool lists, or none at all", () => {
        expect(refusesToolConfig({ additionalTools: [], disabledTools: [] })).toBe(false);
        expect(refusesToolConfig({ searchMode: "auto" })).toBe(false);
        expect(refusesToolConfig(undefined)).toBe(false);
        expect(refusesToolConfig(null)).toBe(false);
    });
});

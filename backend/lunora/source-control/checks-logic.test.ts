import { describe, expect, it } from "vitest";

import { requirementOf, rollupOf } from "./checks-logic";
import { GLOB_MAX_CHARS } from "./glob";
import type { CheckRun, CheckState } from "./types";

const check = (name: string, state: CheckState, required: boolean | null): CheckRun => {
    return { id: null, name, required, state, url: null };
};

describe("requirementOf", () => {
    it("is true for a check a pattern names, whatever else could not be read", () => {
        expect(requirementOf("ci/unit", { complete: true, patterns: ["lint", "ci/*"] })).toBe(true);
        expect(requirementOf("ci/unit", { complete: false, patterns: ["ci/*"] })).toBe(true);
    });

    it("is false only when every source was read and none names the check", () => {
        expect(requirementOf("docs", { complete: true, patterns: ["ci/*"] })).toBe(false);
        expect(requirementOf("docs", { complete: true, patterns: [] })).toBe(false);
    });

    it("is unknown when a source could not be read", () => {
        expect(requirementOf("docs", { complete: false, patterns: ["ci/*"] })).toBeNull();
        expect(requirementOf("docs", { complete: false, patterns: [] })).toBeNull();
    });

    it("is unknown, not optional, when a pattern was too long to compare", () => {
        expect(requirementOf("docs", { complete: true, patterns: ["x".repeat(GLOB_MAX_CHARS + 1)] })).toBeNull();
    });
});

describe("rollupOf", () => {
    it("does not mark a pull request red for an optional failing check", () => {
        const rollup = rollupOf([check("build", "success", true), check("coverage-report", "failure", false)], 2);

        expect(rollup).toEqual({ complete: true, failing: 0, optionalFailing: 1, pending: 0, state: "passing" });
    });

    it("marks it red for a required failing check", () => {
        expect(rollupOf([check("build", "failure", true), check("coverage-report", "failure", false)], 2)).toMatchObject({
            failing: 1,
            optionalFailing: 1,
            state: "failing",
        });
    });

    it("counts a failing check whose requirement is unknown as required", () => {
        expect(rollupOf([check("build", "failure", null)], 1)).toMatchObject({ failing: 1, state: "failing" });
    });

    it("counts a cancelled required check as failing, and an optional one as optional", () => {
        expect(rollupOf([check("a", "cancelled", true)], 1).state).toBe("failing");
        expect(rollupOf([check("a", "cancelled", false)], 1)).toMatchObject({ optionalFailing: 1, state: "passing" });
    });

    it("waits on required checks that are running, not on optional ones", () => {
        expect(rollupOf([check("a", "success", true), check("b", "pending", true)], 2).state).toBe("pending");
        expect(rollupOf([check("a", "success", true), check("b", "pending", false)], 2).state).toBe("passing");
    });

    it("lets a failure win over a pending check", () => {
        expect(rollupOf([check("a", "failure", true), check("b", "pending", true)], 2).state).toBe("failing");
    });

    it("leaves skipped and neutral checks out of the verdict", () => {
        expect(rollupOf([check("a", "skipped", true), check("b", "neutral", true), check("c", "success", true)], 3).state).toBe("passing");
    });

    it("says none when there are no checks, and when only part of them were listed", () => {
        expect(rollupOf([], 0).state).toBe("none");
        expect(rollupOf([check("a", "success", true)], 140)).toMatchObject({ complete: false, state: "passing" });
    });
});

import { describe, expect, it } from "vitest";

import { requirementOf, rollupOf } from "./checks-logic";
import { GLOB_MAX_CHARS } from "./glob";
import type { CheckRun, CheckState, RequiredChecks } from "./types";

const NONE: RequiredChecks = { complete: true, patterns: [] };

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
        const rollup = rollupOf([check("build", "success", true), check("coverage-report", "failure", false)], 2, NONE);

        expect(rollup).toEqual({ complete: true, failing: 0, optionalFailing: 1, pending: 0, state: "passing", waiting: [] });
    });

    it("marks it red for a required failing check", () => {
        expect(rollupOf([check("build", "failure", true), check("coverage-report", "failure", false)], 2, NONE)).toMatchObject({
            failing: 1,
            optionalFailing: 1,
            state: "failing",
        });
    });

    it("counts a failing check whose requirement is unknown as required", () => {
        expect(rollupOf([check("build", "failure", null)], 1, NONE)).toMatchObject({ failing: 1, state: "failing" });
    });

    it("counts a cancelled required check as failing, and an optional one as optional", () => {
        expect(rollupOf([check("a", "cancelled", true)], 1, NONE).state).toBe("failing");
        expect(rollupOf([check("a", "cancelled", false)], 1, NONE)).toMatchObject({ optionalFailing: 1, state: "passing" });
    });

    it("waits on required checks that are running, not on optional ones", () => {
        expect(rollupOf([check("a", "success", true), check("b", "pending", true)], 2, NONE).state).toBe("pending");
        expect(rollupOf([check("a", "success", true), check("b", "pending", false)], 2, NONE).state).toBe("passing");
    });

    it("lets a failure win over a pending check", () => {
        expect(rollupOf([check("a", "failure", true), check("b", "pending", true)], 2, NONE).state).toBe("failing");
    });

    it("leaves skipped and neutral checks out of the verdict", () => {
        expect(rollupOf([check("a", "skipped", true), check("b", "neutral", true), check("c", "success", true)], 3, NONE).state).toBe("passing");
    });

    it("says none when there are no checks, and when only part of them were listed", () => {
        expect(rollupOf([], 0, NONE).state).toBe("none");
        expect(rollupOf([check("a", "success", true)], 140, NONE)).toMatchObject({ complete: false, state: "passing" });
    });

    it("waits on a required check that has not reported yet instead of calling the pull request ready", () => {
        const rollup = rollupOf([check("lint", "success", true)], 1, { complete: true, patterns: ["lint", "build"] });

        expect(rollup).toMatchObject({ pending: 0, state: "pending", waiting: ["build"] });
    });

    it("waits even when nothing has reported", () => {
        expect(rollupOf([], 0, { complete: true, patterns: ["build"] })).toMatchObject({ state: "pending", waiting: ["build"] });
    });

    it("does not wait on a wildcard pattern, which names no one check, or on a name that has reported in any state", () => {
        const rollup = rollupOf([check("build", "success", true)], 1, { complete: true, patterns: ["ci/*", "build", "build", "step?"] });

        expect(rollup).toMatchObject({ state: "passing", waiting: [] });
    });

    it("lets a failure win over a check it is still waiting on, and caps the names it carries", () => {
        const patterns = Array.from({ length: 30 }, (_, index) => `job-${index}`);

        expect(rollupOf([check("a", "failure", true)], 1, { complete: true, patterns: ["x"] }).state).toBe("failing");
        expect(rollupOf([], 0, { complete: true, patterns }).waiting).toHaveLength(10);
    });
});

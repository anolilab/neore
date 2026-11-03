import { describe, expect, it } from "vitest";

import type { BundleReviewEntry } from "./bundle-review";
import { defaultSelection, exportedSkillIds, fitsSkillSlots, selectedCount, toggleSelection } from "./bundle-review";

const byText = (a: string, b: string): number => a.localeCompare(b);

const entry = (key: string, extra: Partial<BundleReviewEntry> = {}): BundleReviewEntry => {
    return { key, kind: key.split(":", 1)[0] as BundleReviewEntry["kind"], problems: [], requires: [], title: key, warnings: [], ...extra };
};

const ENTRIES = [entry("skill:0"), entry("skill:1"), entry("trigger:2", { problems: ["bad cron"] }), entry("group:3", { requires: ["skill:0", "skill:1"] })];

describe("bundle review selection", () => {
    it("picks everything importable at first", () => {
        expect([...defaultSelection(ENTRIES)]).toStrictEqual(["skill:0", "skill:1", "group:3"]);
    });

    it("never ticks an item the server blocked", () => {
        expect(toggleSelection(new Set(), "trigger:2", ENTRIES).size).toBe(0);
    });

    it("ticks the skills a group chat needs along with it", () => {
        expect([...toggleSelection(new Set(), "group:3", ENTRIES)].toSorted(byText)).toStrictEqual(["group:3", "skill:0", "skill:1"]);
    });

    it("unticks the group chats that need a skill when it is unticked", () => {
        expect([...toggleSelection(defaultSelection(ENTRIES), "skill:1", ENTRIES)]).toStrictEqual(["skill:0"]);
    });

    it("counts picks by kind and checks them against the free-account slots", () => {
        const picked = defaultSelection(ENTRIES);

        expect(selectedCount(picked, ENTRIES, "skill")).toBe(2);
        expect(fitsSkillSlots(picked, ENTRIES, 2)).toBe(true);
        expect(fitsSkillSlots(picked, ENTRIES, 1)).toBe(false);
        expect(fitsSkillSlots(picked, ENTRIES, null)).toBe(true);
    });

    it("counts a group chat's participants among the skills an export holds", () => {
        const ids = exportedSkillIds(new Set(["a"]), new Set(["g"]), [
            { id: "g", participantSkillIds: ["a", "b"] },
            { id: "h", participantSkillIds: ["c"] },
        ]);

        expect([...ids].toSorted(byText)).toStrictEqual(["a", "b"]);
    });
});

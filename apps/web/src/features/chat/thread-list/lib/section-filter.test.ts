import { describe, expect, it } from "vitest";

import type { BranchNode, GroupType, ThreadGroup } from "../types";
import { countSections, filterGroupsBySection, nextSectionFilter, sanitizeSectionFilter } from "./section-filter";

const node = (threadId: string, children: BranchNode[] = []): BranchNode => {
    return { branchPoint: 0, branchType: "root", children, createdAt: 0, depth: 0, status: "idle", threadId, title: threadId };
};

const group = (groupType: GroupType, threads: BranchNode[], isCollapsed = false): ThreadGroup => {
    return { groupType, isCollapsed, threads, title: groupType };
};

const needsYou = group("needsYou", [node("n1")]);
const working = group("working", [node("w1"), node("w2")]);
const pinned = group("pinned", [node("p1")]);
const today = group("today", [node("t1"), node("t2"), node("t3")]);
const snoozed = group("snoozed", [node("s1")]);
const archived = group("archived", [node("a1", [node("a1-child")]), node("a2")], true);
const groups = [needsYou, working, pinned, today, snoozed, archived];

describe("sanitizeSectionFilter", () => {
    it("keeps known keys in bar order and falls back to Active for anything else", () => {
        expect(sanitizeSectionFilter(["archived", "needsYou", "bogus"])).toEqual(["needsYou", "archived"]);
        expect(sanitizeSectionFilter([])).toEqual(["active"]);
        expect(sanitizeSectionFilter(["bogus"])).toEqual(["active"]);
        expect(sanitizeSectionFilter("archived")).toEqual(["active"]);
        expect(sanitizeSectionFilter(undefined)).toEqual(["active"]);
    });
});

describe("nextSectionFilter", () => {
    it("shows only the clicked section on a plain click", () => {
        expect(nextSectionFilter(["active", "working"], "archived", false)).toEqual(["archived"]);
    });

    it("adds and removes a section on a shift-click, in bar order", () => {
        expect(nextSectionFilter(["archived"], "active", true)).toEqual(["active", "archived"]);
        expect(nextSectionFilter(["active", "archived"], "archived", true)).toEqual(["active"]);
    });

    it("never leaves the filter empty", () => {
        expect(nextSectionFilter(["working"], "working", true)).toEqual(["working"]);
    });
});

describe("countSections", () => {
    it("counts threads per section, with Needs you inside Active and everything else that is not derived", () => {
        expect(countSections(groups)).toEqual({ active: 1 + 1 + 3, archived: 2, needsYou: 1, snoozed: 1, working: 2 });
    });
});

describe("filterGroupsBySection", () => {
    it("shows Active as everything but Working, Snoozed and Archived, Needs you included", () => {
        expect(filterGroupsBySection(groups, ["active"], undefined)).toEqual([needsYou, pinned, today]);
    });

    it("passes unchanged groups through as the same objects", () => {
        const [first, second] = filterGroupsBySection(groups, ["active"], undefined);

        expect(first).toBe(needsYou);
        expect(second).toBe(pinned);
    });

    it("shows one derived section alone and opens it when it is collapsed", () => {
        const shown = filterGroupsBySection(groups, ["archived"], undefined);

        expect(shown).toHaveLength(1);
        expect(shown[0]?.isCollapsed).toBe(false);
        expect(shown[0]?.threads).toHaveLength(2);
    });

    it("shows several sections at once", () => {
        expect(filterGroupsBySection(groups, ["working", "snoozed"], undefined)).toEqual([working, snoozed]);
    });

    it("opens every picked derived section that is collapsed, not only a section picked alone", () => {
        const collapsedSnoozed = group("snoozed", [node("s1")], true);
        const shown = filterGroupsBySection([working, collapsedSnoozed, archived], ["working", "snoozed", "archived"], undefined);

        expect(shown.map((item) => item.isCollapsed)).toEqual([false, false, false]);
    });

    it("leaves a collapsed date group under Active as the person left it", () => {
        const collapsedToday = group("today", [node("t1")], true);

        expect(filterGroupsBySection([collapsedToday], ["active", "archived"], undefined)).toEqual([collapsedToday]);
    });

    it("keeps the open thread visible in a hidden group, cut to its own root and open", () => {
        const shown = filterGroupsBySection(groups, ["active"], "a1-child");
        const kept = shown.find((candidate) => candidate.groupType === "archived");

        expect(kept?.isCollapsed).toBe(false);
        expect(kept?.threads.map((thread) => thread.threadId)).toEqual(["a1"]);
        expect(shown.map((candidate) => candidate.groupType)).toEqual(["needsYou", "pinned", "today", "archived"]);
    });

    it("hides a hidden group the open thread is not in", () => {
        expect(filterGroupsBySection(groups, ["active"], "t1").map((candidate) => candidate.groupType)).toEqual(["needsYou", "pinned", "today"]);
    });
});

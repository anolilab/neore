import type { BranchNode, ThreadGroup } from "../types";
import { getGroupType } from "../utilities";

/** The sections the section bar offers. "active" is the normal list: everything that is not working, snoozed or archived. */
export type SectionKey = "active" | "archived" | "needsYou" | "snoozed" | "working";

export const SECTION_KEYS: ReadonlyArray<SectionKey> = ["active", "needsYou", "working", "snoozed", "archived"];

export const DEFAULT_SECTION_FILTER: ReadonlyArray<SectionKey> = ["active"];

export type SectionCounts = Readonly<Record<SectionKey, number>>;

export const EMPTY_SECTION_COUNTS: SectionCounts = { active: 0, archived: 0, needsYou: 0, snoozed: 0, working: 0 };

/** What a saved or incoming value means as a filter: known keys in bar order, and never empty. */
export const sanitizeSectionFilter = (value: unknown): SectionKey[] => {
    if (!Array.isArray(value)) {
        return [...DEFAULT_SECTION_FILTER];
    }

    const known = SECTION_KEYS.filter((key) => value.includes(key));

    return known.length > 0 ? known : [...DEFAULT_SECTION_FILTER];
};

/**
 * The filter after a click on a section. A plain click shows only that section; a shift-click adds it to, or takes it out of,
 * the shown ones. Taking out the last one keeps it: the filter is never empty.
 */
export const nextSectionFilter = (current: ReadonlyArray<SectionKey>, key: SectionKey, isAdditive: boolean): SectionKey[] => {
    if (!isAdditive) {
        return [key];
    }

    if (!current.includes(key)) {
        return SECTION_KEYS.filter((candidate) => candidate === key || current.includes(candidate));
    }

    const remaining = current.filter((candidate) => candidate !== key);

    return remaining.length > 0 ? [...remaining] : [...current];
};

/** The section a group belongs to. Project groups hold only active threads, so they count as Active. */
export const sectionOfGroup = (group: ThreadGroup): SectionKey => {
    switch (getGroupType(group)) {
        case "archived": {
            return "archived";
        }
        case "needsYou": {
            return "needsYou";
        }
        case "snoozed": {
            return "snoozed";
        }
        case "working": {
            return "working";
        }
        default: {
            return "active";
        }
    }
};

/** Thread counts per section from the built groups. Needs you is part of Active too, as the list shows it there. */
export const countSections = (groups: ReadonlyArray<ThreadGroup>): SectionCounts => {
    const counts = { ...EMPTY_SECTION_COUNTS } as Record<SectionKey, number>;

    for (const group of groups) {
        const section = sectionOfGroup(group);

        counts[section] += group.threads.length;

        if (section === "needsYou") {
            counts.active += group.threads.length;
        }
    }

    return counts;
};

export const sameSectionCounts = (left: SectionCounts, right: SectionCounts): boolean => SECTION_KEYS.every((key) => left[key] === right[key]);

const containsThread = (node: BranchNode, threadId: string): boolean =>
    node.threadId === threadId || node.children.some((child) => containsThread(child, threadId));

/** Whether a filter shows a group. Needs you shows under Active as well as on its own. */
const showsGroup = (filter: ReadonlyArray<SectionKey>, section: SectionKey): boolean =>
    filter.includes(section) || (section === "needsYou" && filter.includes("active"));

/**
 * The groups a section filter shows. A group the filter hides is kept, cut to the one root that holds the open thread, so the
 * thread being read never leaves the list. A derived section the person picked (Needs you, Working, Snoozed, Archived) is shown
 * open, whatever its collapsed state: Archived and Snoozed start collapsed, and picking one must show its threads. Other shown
 * groups are passed through unchanged, as the same objects.
 */
export const filterGroupsBySection = (
    groups: ReadonlyArray<ThreadGroup>,
    filter: ReadonlyArray<SectionKey>,
    openThreadId: string | undefined,
): ThreadGroup[] => {
    const result: ThreadGroup[] = [];

    for (const group of groups) {
        const section = sectionOfGroup(group);

        if (showsGroup(filter, section)) {
            const isPicked = section !== "active" && filter.includes(section);

            result.push(isPicked && group.isCollapsed === true ? { ...group, isCollapsed: false } : group);
        } else if (openThreadId !== undefined) {
            const root = group.threads.find((thread) => containsThread(thread, openThreadId));

            if (root) {
                result.push({ ...group, isCollapsed: false, threads: [root] });
            }
        }
    }

    return result;
};

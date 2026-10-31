import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupType } from "../types";
import useThreadGroups from "./use-thread-groups";

const state: {
    isPlaceholderData: boolean;
    projects: { _id: string; createdAt: number; title: string }[];
    projectsAnswered: boolean;
} = { isPlaceholderData: true, projects: [], projectsAnswered: false };

const NOW = Date.now();
const composite = {
    pinnedThreads: [],
    relationships: [],
    tags: [],
    temporaryThreads: { page: [] },
    threadOrders: [],
    threads: {
        page: [
            { _id: "t1", _creationTime: NOW, createdAt: NOW, projectId: "p1", status: "active", title: "In project" },
            { _id: "t2", _creationTime: NOW, createdAt: NOW, status: "active", title: "Loose" },
            { _id: "t3", _creationTime: NOW, createdAt: NOW, projectId: "p1", status: "archived", title: "Old project chat" },
        ],
    },
};

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skip"),
        useQuery: () => {
            return { data: composite, isPlaceholderData: state.isPlaceholderData };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    composite: {
                        getThreadListData: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
        useLunoraAuth: () => {
            return { isAuthenticated: true, isLoading: false };
        },
    };
});
vi.mock("@/features/projects/hooks/use-projects", () => {
    return {
        useProjectList: () => {
            return { isAnswered: state.projectsAnswered, projects: state.projects };
        },
    };
});
vi.mock("@/features/chat/core/stores/thread-store-hooks", () => {
    const pins = new Map();
    const statuses = new Map();
    const deletions = new Set();

    return {
        useOptimisticDeletions: () => deletions,
        useOptimisticPins: () => pins,
        useOptimisticStatuses: () => statuses,
    };
});
vi.mock("../contexts/date-boundaries-context", () => {
    const boundaries = { dayKey: "k", sevenDaysAgo: 0, thirtyDaysAgo: 0, today: 0, yesterday: 0 };

    return { useDateBoundaries: () => boundaries };
});
vi.mock("../stores/thread-list-ui-store", () => {
    return { selectSelectedTagIds: () => [], useThreadListUIStore: () => [] };
});
vi.mock("./use-thread-list-cache", () => {
    return { usePersistThreadList: () => {}, useThreadListPlaceholder: () => undefined };
});

const groupsFor = (collapsed: GroupType[] = []) => {
    const { result } = renderHook(() => useThreadGroups(new Set<GroupType>(collapsed), new Set<string>(), "", "threads", undefined, [], undefined, undefined));

    return result.current.threadGroups;
};

const titles = (groups: ReturnType<typeof groupsFor>, title: string) => groups.find((group) => group.title === title)?.threads.map((thread) => thread.title);

describe("project chats while the project list is unavailable", () => {
    beforeEach(() => {
        state.isPlaceholderData = true;
        state.projects = [];
        state.projectsAnswered = false;
    });

    it("keeps stored project chats in a stable group instead of dropping them or dating them", () => {
        const view = groupsFor();

        expect(titles(view, "Projects")).toEqual(["In project"]);
        expect(titles(view, "Today")).toEqual(["Loose"]);
    });

    it("marks the stand-in group read-only and sends archived project chats to the archive", () => {
        const view = groupsFor();

        expect(view.find((group) => group.title === "Projects")?.isPlaceholder).toBe(true);
        expect(titles(view, "Projects")).toEqual(["In project"]);
        expect(titles(view, "Archived")).toEqual(["Old project chat"]);
    });

    it("regroups them under their project once the list answers", () => {
        state.projectsAnswered = true;
        state.projects = [{ _id: "p1", createdAt: 1, title: "Work" }];
        const view = groupsFor();

        expect(titles(view, "Projects")).toBeUndefined();
        expect(titles(view, "Work")).toEqual(["In project"]);
    });

    it("does not hold anything once the real thread list has arrived", () => {
        state.isPlaceholderData = false;
        const view = groupsFor();

        expect(titles(view, "Projects")).toBeUndefined();
        expect(titles(view, "Today")?.toSorted((x, y) => x.localeCompare(y))).toEqual(["In project", "Loose"]);
    });
});

describe("derived sections", () => {
    const original = composite.threads.page;

    beforeEach(() => {
        state.isPlaceholderData = false;
        state.projects = [{ _id: "p1", createdAt: 1, title: "Work" }];
        state.projectsAnswered = true;
    });

    afterEach(() => {
        composite.threads.page = original;
    });

    it("lists Needs you and Working first and Snoozed last, taking those threads out of the groups between", () => {
        composite.threads.page = [
            { _id: "a", _creationTime: NOW, createdAt: NOW, awaitingInput: "question", status: "active", title: "Waiting" },
            { _id: "b", _creationTime: NOW, createdAt: NOW, projectId: "p1", status: "running", title: "Busy project chat" },
            { _id: "c", _creationTime: NOW, createdAt: NOW, snoozedUntil: Date.now() + 3_600_000, status: "active", title: "Later" },
            { _id: "d", _creationTime: NOW, createdAt: NOW, status: "active", title: "Plain" },
        ] as never;
        const view = groupsFor();

        expect(view.map((group) => group.title)).toEqual(["Needs you", "Working", "Work", "Today", "Snoozed"]);
        expect(titles(view, "Needs you")).toEqual(["Waiting"]);
        expect(titles(view, "Working")).toEqual(["Busy project chat"]);
        expect(titles(view, "Work")).toEqual([]);
        expect(titles(view, "Today")).toEqual(["Plain"]);
        expect(view.filter((group) => group.isPlaceholder).map((group) => group.title)).toEqual(["Needs you", "Working", "Snoozed"]);
    });

    it("opens Snoozed collapsed and expands it once the stored state says so", () => {
        composite.threads.page = [
            { _id: "c", _creationTime: NOW, createdAt: NOW, snoozedUntil: Date.now() + 3_600_000, status: "active", title: "Later" },
        ] as never;

        expect(groupsFor().find((group) => group.title === "Snoozed")?.isCollapsed).toBe(true);
        expect(groupsFor(["snoozed"]).find((group) => group.title === "Snoozed")?.isCollapsed).toBe(false);
    });

    it("hides the sections while empty and returns an elapsed snooze to its group", () => {
        composite.threads.page = [{ _id: "c", _creationTime: NOW, createdAt: NOW, snoozedUntil: Date.now() - 1, status: "active", title: "Back" }] as never;
        const view = groupsFor();

        expect(view.map((group) => group.title)).toEqual(["Work", "Today"]);
        expect(titles(view, "Today")).toEqual(["Back"]);
    });
});

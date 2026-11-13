import { act, render, renderHook } from "@testing-library/react";
import { startTransition, Suspense, use, useLayoutEffect, useState } from "react";
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

const lingui = vi.hoisted(() => {
    return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
});

vi.mock("@lingui/react/macro", () => {
    return {
        // One `t` for every render, as Lingui's is for a locale.
        useLingui: () => lingui,
    };
});

/** How many times the nodes were deep-compared with the previous build's. */
const shareCalls = vi.hoisted(() => {
    return { count: 0 };
});

vi.mock("../lib/share-unchanged-nodes", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/share-unchanged-nodes")>();

    return {
        ...actual,
        shareUnchangedNodes: (...args: Parameters<typeof actual.shareUnchangedNodes>) => {
            shareCalls.count += 1;

            return actual.shareUnchangedNodes(...args);
        },
    };
});
vi.mock("@tanstack/react-query", async (importOriginal) => {
    const { replaceEqualDeep } = await importOriginal<typeof import("@tanstack/react-query")>();

    return {
        // The node sharing uses the real one.
        replaceEqualDeep,
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

    it("marks a snoozed stateless root idle when its snooze ends, with no regular snoozed root to wake the timer", () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);

        // Real timers come back even when an assertion fails, so no later test runs on the fake clock.
        try {
            composite.threads.page = [
                {
                    _id: "s",
                    _creationTime: NOW,
                    createdAt: NOW,
                    lastReplyAt: NOW - 10,
                    scheduled: false,
                    snoozedUntil: NOW + 60_000,
                    statelessMode: true,
                    status: "active",
                    title: "Stateless",
                },
            ] as never;
            const { result } = renderHook(() => useThreadGroups(new Set<GroupType>(), new Set<string>(), "", "threads", undefined, [], undefined, undefined));
            const idleOf = () => result.current.threadGroups.find((group) => group.title === "Stateless")?.threads[0]?.isIdle;

            expect(idleOf()).toBe(false);

            act(() => {
                vi.advanceTimersByTime(60_100);
            });

            expect(idleOf()).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("node identity across rebuilds", () => {
    const original = composite.threads.page;

    beforeEach(() => {
        state.isPlaceholderData = false;
        state.projects = [{ _id: "p1", createdAt: 1, title: "Work" }];
        state.projectsAnswered = true;
        composite.threads.page = [
            { _id: "a", _creationTime: NOW, createdAt: NOW, status: "active", title: "First" },
            { _id: "b", _creationTime: NOW, createdAt: NOW, projectId: "p1", status: "active", title: "Second" },
            { _id: "c", _creationTime: NOW, createdAt: NOW, status: "active", title: "Third" },
        ] as never;
    });

    afterEach(() => {
        composite.threads.page = original;
    });

    const nodesOf = (groups: ReturnType<typeof groupsFor>) => new Map(groups.flatMap((group) => group.threads).map((node) => [node.threadId, node]));

    it("keeps every other thread's node when one thread's status changes, so only that row re-renders", () => {
        const collapsedGroups = new Set<GroupType>();
        const collapsedProjects = new Set<string>();
        const { rerender, result } = renderHook(() => useThreadGroups(collapsedGroups, collapsedProjects, "", "threads", undefined, [], undefined, undefined));
        const before = nodesOf(result.current.threadGroups);

        // A live push is a freshly decoded page: every thread object is new, and one of them changed.
        composite.threads.page = (structuredClone(composite.threads.page) as { _id: string; status: string }[]).map((thread) =>
            thread._id === "c" ? { ...thread, status: "running" } : thread,
        ) as never;
        rerender();
        const after = nodesOf(result.current.threadGroups);

        expect(after.get("a")).toBe(before.get("a"));
        expect(after.get("b")).toBe(before.get("b"));
        expect(after.get("c")).not.toBe(before.get("c"));
        expect(after.get("c")?.status).toBe("running");
    });

    it("keeps every node when a rebuild changes nothing in them", () => {
        const collapsedGroups = new Set<GroupType>();
        const collapsedProjects = new Set<string>();
        const { rerender, result } = renderHook(() => useThreadGroups(collapsedGroups, collapsedProjects, "", "threads", undefined, [], undefined, undefined));
        const before = nodesOf(result.current.threadGroups);

        composite.threads.page = structuredClone(composite.threads.page);
        rerender();
        const after = nodesOf(result.current.threadGroups);

        expect([...after.keys()]).toStrictEqual([...before.keys()]);

        for (const [threadId, node] of after) {
            expect(node).toBe(before.get(threadId));
        }
    });

    it("compares with the list on screen, not with a render React threw away", async () => {
        const collapsedGroups = new Set<GroupType>();
        const collapsedProjects = new Set<string>();
        const harness: { abandon?: () => void; groups?: ReturnType<typeof groupsFor>; push?: () => void } = {};
        // A render that suspends here never commits: the transition that asked for it is thrown away.
        const never = new Promise<never>(() => {});
        const Pending = ({ abandon }: { abandon: boolean }) => {
            if (abandon) {
                use(never);
            }

            return null;
        };
        const List = () => {
            const { threadGroups } = useThreadGroups(collapsedGroups, collapsedProjects, "", "threads", undefined, [], undefined, undefined);

            // Only what commits is on screen.
            useLayoutEffect(() => {
                harness.groups = threadGroups;
            });

            return null;
        };
        const Host = () => {
            const [abandon, setAbandon] = useState(false);
            const [, setPush] = useState(0);

            useLayoutEffect(() => {
                harness.abandon = () => startTransition(() => setAbandon(true));
                harness.push = () => setPush((value) => value + 1);
            }, []);

            return (
                <Suspense fallback={null}>
                    <List />
                    <Pending abandon={abandon} />
                </Suspense>
            );
        };
        const { page } = composite.threads;

        render(<Host />);
        const before = nodesOf(harness.groups ?? []);

        // A push changes "c", and the only render that read it is thrown away...
        composite.threads.page = (structuredClone(page) as { _id: string; status: string }[]).map((thread) =>
            thread._id === "c" ? { ...thread, status: "running" } : thread,
        ) as never;
        await act(async () => {
            harness.abandon?.();
        });

        // ...then the next push brings "c" back as it is on screen: its row keeps its node.
        composite.threads.page = structuredClone(page);
        act(() => {
            harness.push?.();
        });
        const after = nodesOf(harness.groups ?? []);

        expect(after.get("c")?.status).toBe("active");
        expect(after.get("c")).toBe(before.get("c"));
        expect(after.get("a")).toBe(before.get("a"));
    });

    it("commits once per push: keeping the shared nodes adds no render to the screen", () => {
        const collapsedGroups = new Set<GroupType>();
        const collapsedProjects = new Set<string>();
        const commits = { count: 0 };
        const List = () => {
            useThreadGroups(collapsedGroups, collapsedProjects, "", "threads", undefined, [], undefined, undefined);

            useLayoutEffect(() => {
                commits.count += 1;
            });

            return null;
        };
        const { rerender } = render(<List />);

        expect(commits.count).toBe(1);

        composite.threads.page = (structuredClone(composite.threads.page) as { _id: string; status: string }[]).map((thread) =>
            thread._id === "c" ? { ...thread, status: "running" } : thread,
        ) as never;
        rerender(<List />);

        expect(commits.count).toBe(2);
    });

    it("compares an unchanged push once, and nothing on the renders after it", () => {
        const collapsedGroups = new Set<GroupType>();
        const collapsedProjects = new Set<string>();
        const { rerender, result } = renderHook(() => useThreadGroups(collapsedGroups, collapsedProjects, "", "threads", undefined, [], undefined, undefined));
        const before = nodesOf(result.current.threadGroups);

        // A live push that changes nothing: a fresh page, equal to the one on screen.
        composite.threads.page = structuredClone(composite.threads.page);
        shareCalls.count = 0;
        rerender();

        expect(shareCalls.count).toBe(1);

        // Renders after it bring no new build: nothing is compared again.
        shareCalls.count = 0;
        rerender();
        rerender();

        expect(shareCalls.count).toBe(0);

        const after = nodesOf(result.current.threadGroups);

        for (const [threadId, node] of after) {
            expect(node).toBe(before.get(threadId));
        }
    });
});

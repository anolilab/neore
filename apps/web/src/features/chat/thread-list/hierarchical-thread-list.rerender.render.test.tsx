// @vitest-environment jsdom

/**
 * Which rows of the sidebar list render again when one thing changes. Each count is the number of times a row's `ThreadNode` ran:
 * a thread switch, an arrow key, or one thread's pull request count must reach only the rows whose state changed.
 */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useMemo, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BranchNode, LoadingStates, ThreadGroup } from "./types";

const renders = vi.hoisted(() => new Map<string, number>());

/** The route the list is on, with the subscribe/select contract of the router's `useLocation`. */
const route = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { pathname: "/chat" };

    return {
        set: (pathname: string) => {
            state.pathname = pathname;
            listeners.forEach((listener) => listener());
        },
        state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    };
});

/** The pull request counts the list's one query returns. */
const pullRequestCounts = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { counts: new Map<string, number>() as ReadonlyMap<string, number> };

    return {
        set: (counts: ReadonlyMap<string, number>) => {
            state.counts = counts;
            listeners.forEach((listener) => listener());
        },
        state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return { msg: (strings: TemplateStringsArray) => strings[0], plural: () => "" };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        Plural: () => null,
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { chat: { functions: {} } } };
});

vi.mock("@tanstack/react-router", () => {
    const router = { navigate: async () => {}, preloadRoute: async () => {}, state: { location: route.state } };

    return {
        Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
        useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) => {
            const selected = useSyncExternalStore(route.subscribe, () =>
                options?.select ? options.select({ pathname: route.state.pathname }) : route.state.pathname,
            );

            return options?.select ? selected : { pathname: selected };
        },
        useNavigate: () => router.navigate,
        useRouter: () => router,
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate: () => {}, mutateAsync: async () => {} };
        },
        useQueryClient: () => {
            return {};
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    // Every cRPC path answers with options nothing reads: the rows only build mutations from them.
    const entry: object = new Proxy(
        {},
        {
            get: (_target, key) => {
                if (key === "mutationOptions" || key === "queryOptions") {
                    return () => {
                        return {};
                    };
                }

                return key === "queryKey" ? () => [] : entry;
            },
        },
    );

    return {
        createLunoraQueryOptions: () => {
            return {};
        },
        useCRPC: () => entry,
        useLunora: () => {
            return {};
        },
        useLunoraActionOptions: () => {
            return {};
        },
    };
});

vi.mock("@neore/client-runtime", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@neore/client-runtime")>()),
        forgetUnlockProof: () => {},
        // Called once each time a row renders: the count this test reads.
        useUnlockProof: (threadId: string) => {
            renders.set(threadId, (renders.get(threadId) ?? 0) + 1);

            return undefined;
        },
    };
});

vi.mock("@/features/develop/lib/use-develop", () => {
    return {
        usePullRequestCounts: () => useSyncExternalStore(pullRequestCounts.subscribe, () => pullRequestCounts.state.counts),
    };
});

vi.mock("@/hooks/use-after-first-paint", () => {
    return { default: () => true };
});

vi.mock("@/features/projects/hooks/use-projects", () => {
    const mutation = { mutateAsync: async () => {} };

    return {
        useDeleteProject: () => mutation,
        useMoveThreadToProject: () => mutation,
        usePinProject: () => mutation,
        useProjects: () => [],
        useUnpinProject: () => mutation,
        useUpdateProjectOrder: () => mutation,
    };
});

const threadIds = [1, 2, 3, 4, 5].map((index) => `00000000-0000-4000-8000-00000000000${index}`);
const groups: ThreadGroup[] = [
    {
        groupType: "today",
        threads: threadIds.map(
            (threadId) =>
                ({
                    branchPoint: 0,
                    branchType: "root",
                    children: [],
                    createdAt: 0,
                    depth: 0,
                    status: "idle",
                    threadId,
                    title: threadId,
                }) as unknown as BranchNode,
        ),
        title: "Today",
    } as unknown as ThreadGroup,
];

vi.mock("./hooks/use-thread-groups", () => {
    const result = { isPlaceholderData: false, threadGroups: groups, threadsData: {} };

    return { default: () => result };
});

// The real handlers close over the open thread (deleting it moves the route): new functions each time it changes.
vi.mock("./hooks/use-thread-handlers", () => {
    const handlersFor = (currentThreadId: string | undefined) => {
        const handler = () => currentThreadId;

        return {
            handleBulkDeleteThreads: async () => {},
            handleCreateBranch: handler,
            handleDeleteThread: handler,
            handleDownloadThread: handler,
            handlePinThread: handler,
            handleUnpinThread: handler,
            updateThread: handler,
        };
    };
    const useThreadHandlersStub = (_setLoadingStates: unknown, currentThreadId?: string) => useMemo(() => handlersFor(currentThreadId), [currentThreadId]);

    return { default: useThreadHandlersStub };
});

vi.mock("@/lib/toast", () => {
    return { showError: () => {}, showInfo: () => {}, showSuccess: () => {}, showWarning: () => {} };
});

vi.mock("@/hooks/use-has-opened", () => {
    return { useHasOpened: () => false };
});

vi.mock("@/components/delete-confirmation-dialog", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/core/stores/prompt-queue-store", () => {
    return {
        usePromptQueueStore: {
            getState: () => {
                return { setPaused: () => {} };
            },
        },
    };
});

vi.mock("@/features/chat/lock/thread-lock-dialog", () => {
    return { ThreadLockDialog: () => null };
});

vi.mock("@/features/chat/tags/thread-categories", () => {
    return { THREAD_CATEGORY_LABELS: {} };
});

vi.mock("@/features/chat/tags/thread-tag-chips", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/tags/thread-tags-menu", () => {
    return { default: () => null };
});

vi.mock("@/features/projects/components/move-to-project-dialog", () => {
    return { default: () => null };
});

vi.mock("./message-search-matches", () => {
    return { default: () => null };
});

vi.mock("./group-header", () => {
    return { default: () => null };
});

vi.mock("./rename-thread-dialog", () => {
    return { default: () => null };
});

vi.mock("./snooze-until-dialog", () => {
    return { default: () => null };
});

const { default: HierarchicalThreadList } = await import("./hierarchical-thread-list");

const loadingStates: LoadingStates = {
    archiving: new Set(),
    branching: new Set(),
    deleting: new Set(),
    downloading: new Set(),
    pinning: new Set(),
    reordering: false,
};

const listProps = {
    collapsedGroups: new Set(),
    collapsedProjects: new Set(),
    expandedThreads: new Set<string>(),
    isSearchLoading: false,
    isSelectionMode: false,
    lastSelectedIndex: -1,
    loadingStates,
    messageSearchResults: undefined,
    onExitSelectionMode: () => {},
    searchQuery: "",
    searchType: "threads",
    selectedThreadIds: new Set<string>(),
    setLastSelectedIndex: () => {},
    setLoadingStates: () => {},
    setSelectedThreadIds: () => {},
    setShowKeyboardHelp: () => {},
    showKeyboardHelp: false,
    threadRelationships: [],
    threadSearchResults: undefined,
    toggleExpanded: () => {},
    toggleGroupCollapsed: () => {},
} as unknown as Omit<Parameters<typeof HierarchicalThreadList>[0], "currentThreadId">;

/** The rows that rendered while `change` ran. */
const rowsUpdatedBy = (change: () => void): string[] => {
    renders.clear();
    act(change);

    return threadIds.filter((threadId) => renders.has(threadId));
};

const [first, second, third] = threadIds as [string, string, string];

beforeEach(() => {
    // The drag-and-drop context constructs its observer with `new`; the shared setup's stub is not a constructor.
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
    route.set(`/chat/${first}`);
    pullRequestCounts.set(new Map());
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the sidebar thread list", () => {
    it("re-renders only the row it leaves and the row it opens on a thread switch", () => {
        const { rerender } = render(<HierarchicalThreadList {...listProps} currentThreadId={first} />);

        // The list's owner reads the same route, so the new thread reaches the list as a prop in the same change.
        const updatedRows = rowsUpdatedBy(() => {
            route.set(`/chat/${second}`);
            rerender(<HierarchicalThreadList {...listProps} currentThreadId={second} />);
        });

        expect(updatedRows).toStrictEqual([first, second]);
    });

    it("re-renders only the row the arrow key leaves and the row it reaches", () => {
        render(<HierarchicalThreadList {...listProps} currentThreadId={first} />);

        // The first press starts keyboard navigation on the first row.
        fireEvent.keyDown(document.body, { key: "ArrowDown" });

        expect(rowsUpdatedBy(() => fireEvent.keyDown(document.body, { key: "ArrowDown" }))).toStrictEqual([first, second]);
        expect(rowsUpdatedBy(() => fireEvent.keyDown(document.body, { key: "ArrowDown" }))).toStrictEqual([second, third]);
    });

    it("highlights the row the arrow keys select, by its thread, and no other", () => {
        const { container } = render(<HierarchicalThreadList {...listProps} currentThreadId={first} />);
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the highlight is only a class
        const highlighted = () => [...container.querySelectorAll<HTMLElement>("[data-thread-id]")].filter((row) => row.className.includes("ring-white/50"));

        fireEvent.keyDown(document.body, { key: "ArrowDown" });
        fireEvent.keyDown(document.body, { key: "ArrowDown" });

        expect(highlighted().map((row) => row.dataset.threadId)).toStrictEqual([second]);
    });

    it("re-renders only the row whose linked pull request count changed", () => {
        render(<HierarchicalThreadList {...listProps} currentThreadId={first} />);

        expect(rowsUpdatedBy(() => pullRequestCounts.set(new Map([[third, 1]])))).toStrictEqual([third]);
    });
});

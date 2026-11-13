// @vitest-environment jsdom

/**
 * What the sidebar shows while searching, with the real list, rows and message snippets: the rows on screen and their snippets
 * always come from the same answer, a failed search says so, an answer never crosses an organization switch, and a cleared box
 * never asks its old query again.
 */
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadListUIStore } from "./stores/thread-list-ui-store";

/** The searches the server was asked, each answered (or failed) by the test. */
const searches = vi.hoisted(() => [] as { fail: () => void; organizationId?: string | null; query: string; respond: (page: unknown[]) => void }[]);

/** The active organization, switchable while the list is on screen. */
const organization = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { id: "org-a" };

    return {
        set: (id: string) => {
            state.id = id;
            listeners.forEach((listener) => listener());
        },
        state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    };
});

const lingui = vi.hoisted(() => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return { i18n: { _: (value: string) => value }, t };
});

vi.mock("@lingui/core/macro", () => {
    return { msg: (strings: TemplateStringsArray) => strings[0], plural: () => "" };
});

vi.mock("@lingui/react/macro", () => {
    return { Plural: () => null, useLingui: () => lingui };
});

vi.mock("@neore/backend/api", () => {
    return { api: { chat: { functions: {} } } };
});

vi.mock("@tanstack/react-router", () => {
    const router = { navigate: async () => {}, preloadRoute: async () => {}, state: { location: { pathname: "/chat" } } };

    return {
        Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
        useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) =>
            options?.select ? options.select({ pathname: "/chat" }) : { pathname: "/chat" },
        useNavigate: () => router.navigate,
        useRouter: () => router,
    };
});

const NOW = Date.now();
const composite = {
    pinnedThreads: [],
    relationships: [],
    tags: [],
    temporaryThreads: { page: [] },
    threadOrders: [],
    threads: { page: [{ _creationTime: NOW, _id: "inbox", createdAt: NOW, status: "active", title: "Inbox chat" }] },
};

vi.mock("@/lib/lunora/crpc", () => {
    /** Asks the server: the test answers or fails the search later. */
    const ask = (args: { organizationId?: string | null; searchQuery: string }) =>
        new Promise((resolve, reject) => {
            const fail = () => reject(new Error("search failed"));
            const respond = (page: unknown[]) => resolve({ page });

            searches.push({ fail, organizationId: args.organizationId, query: args.searchQuery, respond });
        });
    const searchOptions = (name: string) => {
        return {
            queryOptions: (args: typeof skipToken | { organizationId?: string | null; searchQuery: string }) => {
                if (args === skipToken) {
                    return { queryFn: skipToken, queryKey: [name, "skip"] };
                }

                return { queryFn: () => ask(args), queryKey: [name, args] };
            },
        };
    };
    // Every other cRPC path answers with options nothing reads: the rows only build mutations from them.
    const entry: object = new Proxy(
        {},
        {
            get: (_target, key) => {
                if (key === "mutationOptions") {
                    return () => {
                        return { mutationFn: async () => {} };
                    };
                }

                return key === "queryKey" ? () => [] : entry;
            },
        },
    );

    const searchFunctions = { searchMessages: searchOptions("searchMessages"), searchThreads: searchOptions("searchThreads") };

    return {
        createLunoraQueryOptions: () => {
            return {};
        },
        useCRPC: () => {
            return {
                agent: entry,
                chat: {
                    composite: {
                        getThreadListData: {
                            queryOptions: (args: unknown) =>
                                args === skipToken
                                    ? { queryFn: skipToken, queryKey: ["threadList"] }
                                    : { queryFn: async () => composite, queryKey: ["threadList"] },
                        },
                    },
                    functions: new Proxy(searchFunctions, { get: (target, key) => (Object.hasOwn(target, key) ? target[key as keyof typeof target] : entry) }),
                    thread_state: entry,
                },
                source_control: entry,
            };
        },
        useLunora: () => {
            return {};
        },
        useLunoraActionOptions: () => {
            return { mutationFn: async () => {} };
        },
        useLunoraAuth: () => {
            return { isAuthenticated: true, isLoading: false };
        },
    };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthActiveOrganization: () => {
            const id = useSyncExternalStore(organization.subscribe, () => organization.state.id);

            return { data: { id } };
        },
    };
});

vi.mock("@neore/client-runtime", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@neore/client-runtime")>()),
        forgetUnlockProof: () => {},
        useUnlockProof: () => undefined,
    };
});

vi.mock("@/features/develop/lib/use-develop", () => {
    const counts = new Map();

    return { usePullRequestCounts: () => counts };
});

vi.mock("@/hooks/use-after-first-paint", () => {
    return { default: () => true };
});

vi.mock("@/features/projects/hooks/use-projects", () => {
    const mutation = { mutateAsync: async () => {} };
    const projectList = { isAnswered: true, projects: [] };

    return {
        useDeleteProject: () => mutation,
        useMoveThreadToProject: () => mutation,
        usePinProject: () => mutation,
        useProjectList: () => projectList,
        useProjects: () => projectList.projects,
        useUnpinProject: () => mutation,
        useUpdateProjectOrder: () => mutation,
    };
});

vi.mock("./hooks/use-thread-list-cache", () => {
    return { usePersistThreadList: () => {}, useThreadListPlaceholder: () => undefined };
});

// The snippets' "go to message" jump needs the chat's message list; nothing here clicks one.
vi.mock("@/features/chat/thread/message-list", () => {
    return { scrollToMessage: () => {} };
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

vi.mock("@/features/chat/tags/manage-thread-tags-dialog", () => {
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

vi.mock("@/features/chat/tags/thread-tag-chips", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/tags/thread-tags-menu", () => {
    return { default: () => null };
});

vi.mock("@/features/projects/components/move-to-project-dialog", () => {
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

const { default: ThreadList } = await import("./thread-list");

/** A snippet's accessible name, and the two windows: cut around each query's match, past the start of the message. */
const SNIPPET_NAME = /^Go to message:/u;
const ALPHA_SNIPPET = /^Go to message: ….*alpha release/u;
const ZULU_SNIPPET = /^Go to message: ….*alpha zulu plan/u;

/** A quick typist's gap between keys, and a pause long enough for any search debounce. */
const KEY_GAP_MS = 40;
const PAUSE_MS = 1000;

/** A message whose match sits past the snippet's 40-character window, so a snippet cut for another query starts elsewhere. */
const FILLER = "The quarterly planning notes cover several unrelated topics first, and only then";
const messageHit = (threadId: string, title: string, text: string) => {
    return {
        _creationTime: NOW,
        _id: threadId,
        createdAt: NOW,
        relevantMessages: [{ _id: `${threadId}-m`, order: 0, stepOrder: 0, text }],
        status: "active",
        title,
    };
};

const type = (text: string) => {
    for (let index = 1; index <= text.length; index += 1) {
        act(() => {
            useThreadListUIStore.getState().setSearchQuery(text.slice(0, index));
            vi.advanceTimersByTime(KEY_GAP_MS);
        });
    }
};

const settle = async (ms = PAUSE_MS) => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
};

const answer = async (index: number, page: unknown[]) => {
    await act(async () => {
        searches[index]?.respond(page);
        await vi.advanceTimersByTimeAsync(0);
    });
};

/** The accessible names of the message snippets on screen. */
const snippetNames = () => screen.queryAllByRole("button", { name: SNIPPET_NAME }).map((button) => button.getAttribute("aria-label"));

const renderList = async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
        <QueryClientProvider client={queryClient}>
            <ThreadList />
        </QueryClientProvider>,
    );
    await settle(0);
};

beforeEach(() => {
    vi.useFakeTimers();
    searches.length = 0;
    organization.set("org-a");
    useThreadListUIStore.getState().reset();
    // The drag-and-drop context constructs its observer with `new`; the shared setup's stub is not a constructor.
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("the sidebar search, as shown", () => {
    it("keeps the previous answer's rows and snippets together while the next query runs, then swaps both", async () => {
        act(() => {
            useThreadListUIStore.getState().setSearchType("messages");
        });
        await renderList();

        type("alpha");
        await settle();
        await answer(0, [messageHit("release", "Release notes", `${FILLER} the alpha release ships.`)]);

        const firstSnippets = snippetNames();

        expect(screen.getByText("Release notes")).toBeTruthy();
        // Cut around "alpha": the window starts mid-text.
        expect(firstSnippets).toStrictEqual([expect.stringMatching(ALPHA_SNIPPET)]);

        // The next query is asked and not answered yet: the same rows, with snippets still cut for the query that found them.
        type("alpha zulu");
        await settle();

        expect(searches.map((search) => search.query)).toStrictEqual(["alpha", "alpha zulu"]);
        expect(screen.getByText("Release notes")).toBeTruthy();
        expect(snippetNames()).toStrictEqual(firstSnippets);

        await answer(1, [messageHit("zulu", "Zulu plan", `${FILLER} the alpha zulu plan.`)]);

        expect(screen.queryByText("Release notes")).toBeNull();
        expect(screen.getByText("Zulu plan")).toBeTruthy();
        expect(snippetNames()).toStrictEqual([expect.stringMatching(ZULU_SNIPPET)]);
    });

    it("says a search failed instead of showing every thread as if none ran", async () => {
        await renderList();

        expect(screen.getByText("Inbox chat")).toBeTruthy();

        type("boom");
        await settle();
        await act(async () => {
            searches[0]?.fail();
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(screen.getByRole("alert").textContent).toBe('Search failed for "boom". Try again.');
        expect(screen.queryByText("Inbox chat")).toBeNull();
    });

    it("never shows one organization's answer after switching to another", async () => {
        await renderList();

        type("plan");
        await settle();
        await answer(0, [{ _creationTime: NOW, _id: "a-plan", createdAt: NOW, status: "active", title: "Org A plan" }]);

        expect(screen.getByText("Org A plan")).toBeTruthy();

        act(() => {
            organization.set("org-b");
        });
        await settle(0);

        // Org B's search is asked; until it answers, org A's rows are gone.
        expect(searches.at(-1)).toMatchObject({ organizationId: "org-b", query: "plan" });
        expect(screen.queryByText("Org A plan")).toBeNull();

        await answer(searches.length - 1, [{ _creationTime: NOW, _id: "b-plan", createdAt: NOW, status: "active", title: "Org B plan" }]);

        expect(screen.getByText("Org B plan")).toBeTruthy();
    });

    it("keeps a message search's hits across an organization switch: message search is the person's own", async () => {
        act(() => {
            useThreadListUIStore.getState().setSearchType("messages");
        });
        await renderList();

        type("alpha");
        await settle();
        await answer(0, [messageHit("release", "Release notes", `${FILLER} the alpha release ships.`)]);

        expect(screen.getByText("Release notes")).toBeTruthy();

        act(() => {
            organization.set("org-b");
        });
        await settle(0);

        // Nothing new is asked, and the hits stay.
        expect(searches).toHaveLength(1);
        expect(screen.getByText("Release notes")).toBeTruthy();
        expect(snippetNames()).toStrictEqual([expect.stringMatching(ALPHA_SNIPPET)]);
    });

    it("does not ask the cleared query again when the box is cleared and typed into within the pause", async () => {
        await renderList();

        type("alpha");
        await settle();
        await answer(0, [{ _creationTime: NOW, _id: "a", createdAt: NOW, status: "active", title: "Alpha chat" }]);

        // Cleared, then a new letter before the pause ends.
        act(() => {
            useThreadListUIStore.getState().setSearchQuery("");
        });
        act(() => {
            useThreadListUIStore.getState().setSearchQuery("b");
        });
        await settle(100);

        expect(searches.map((search) => search.query)).toStrictEqual(["alpha"]);
        expect(screen.queryByText("Alpha chat")).toBeNull();

        await settle();

        expect(searches.map((search) => search.query)).toStrictEqual(["alpha", "b"]);
    });
});

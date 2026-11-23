/**
 * Message search in the command palette: it waits for two characters and a
 * pause in typing, shows its hits below the thread-title groups, and opens the
 * hit's thread at the message.
 */

import { MutationObserver, QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCommandDialogStore } from "./command-dialog-store";
import GlobalCommandPalette from "./command-palette";

const harness = vi.hoisted(() => {
    return {
        navigate: vi.fn(),
        scrollToMessage: vi.fn(),
        searchArgs: [] as unknown[],
        /** The thread rows the palette lists; a test may replace them. */
        threads: [{ _id: "thread-1", status: "active", title: "Alpha plan" }] as Record<string, unknown>[],
        /** Whether the thread list has more pages than the palette loaded. */
        hasMore: false,
        /** What the meaning search returns for any query; a test may replace it. */
        meaning: [] as Record<string, unknown>[],
        meaningArgs: [] as unknown[],
        /** Whether the meaning search is refused, as a rate limit would. */
        meaningFails: false,
        /** Whether the account's model rules refuse the meaning search's embedding model. */
        meaningRefused: false,
        /** The project rows the palette lists; a test may replace them. */
        projects: [] as { _id: string; title: string }[],
        /** Whether the project list has more pages than the palette loaded. */
        projectsHasMore: false,
        /** Whether the project list read fails. */
        projectsFail: false,
        /** The signed-in account; a test may switch it. */
        userId: "user-1",
    };
});

// An admin impersonating the owner hides the chat's archive and delete; these tests act as the owner themselves.
vi.mock("@/features/admin/hooks/use-is-impersonating", () => {
    return { useImpersonating: () => false };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const searchMessages = {
        queryOptions: (args: unknown) => {
            harness.searchArgs.push(args);

            return {
                queryFn: async () => {
                    const query = (args as { searchQuery: string }).searchQuery;

                    if (query.startsWith("gamma")) {
                        const busy = Array.from({ length: 9 }, (_, index) => {
                            return { _id: `busy-${index}`, order: index, stepOrder: 0, text: `gamma busy match ${index}` };
                        });

                        return {
                            continueCursor: "",
                            isDone: true,
                            page: [
                                { _id: "thread-busy", relevantMessages: busy, title: "Busy thread" },
                                {
                                    _id: "thread-quiet",
                                    relevantMessages: [{ _id: "quiet-0", order: 1, stepOrder: 0, text: "gamma quiet match" }],
                                    title: "Quiet thread",
                                },
                            ],
                        };
                    }

                    const [id, text] = query.startsWith("beta")
                        ? ["message-7", "The beta cohort starts in May"]
                        : ["message-9", "We agreed on the alpha rollout date"];

                    return {
                        continueCursor: "",
                        isDone: true,
                        page: [{ _id: "thread-2", relevantMessages: [{ _id: id, order: 3, stepOrder: 0, text }], title: "Launch notes" }],
                    };
                },
                queryKey: ["searchMessages", args],
            };
        },
    };
    const pinned = {
        queryOptions: () => {
            return { queryFn: async () => [], queryKey: ["pinned"] };
        },
    };

    return {
        useAction: () => async (args: unknown) => {
            harness.meaningArgs.push(args);

            if (harness.meaningFails) {
                throw new Error("Rate limited");
            }

            if (harness.meaningRefused) {
                throw Object.assign(new Error("Search by meaning is not available under your model rules"), {
                    code: "FORBIDDEN",
                    data: { code: "MEANING_SEARCH_REFUSED" },
                });
            }

            return harness.meaning;
        },
        useCRPC: () => {
            return { chat: { functions: { getPinnedThreads: pinned, searchMessages } } };
        },
        useLunoraAuth: () => {
            return { isAuthenticated: true, isLoading: false };
        },
    };
});

vi.mock("@/features/projects/hooks/use-projects", () => {
    return {
        useProjectList: () => {
            return { hasMore: harness.projectsHasMore, isAnswered: !harness.projectsFail, isError: harness.projectsFail, projects: harness.projects };
        },
    };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => {
            return { data: { user: { id: harness.userId } } };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => vi.fn(),
        useRouter: () => {
            return { navigate: harness.navigate };
        },
    };
});

vi.mock("@/features/chat/thread/message-list", () => {
    return { scrollToMessage: harness.scrollToMessage };
});

vi.mock("@/features/chat/core/hooks/use-all-threads-data", () => {
    return {
        default: () => {
            return { hasMore: harness.hasMore, lunora: harness.threads };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-current-model", () => {
    return { default: () => "model" };
});

vi.mock("@/features/chat/core/hooks/use-thread-manager", () => {
    return {
        useThreadManager: () => {
            return { deleteBranch: undefined, switchToBranch: vi.fn() };
        },
    };
});

vi.mock("@/features/chat/core/stores/thread-store-hooks", () => {
    return { useCurrentThreadId: () => undefined, useThreadMetadata: () => new Map() };
});

vi.mock("@/features/chat/thread-list/hooks/use-thread-handlers", () => {
    return {
        default: () => {
            return { handleCreateBranch: vi.fn(), handlePinThread: vi.fn(), handleUnpinThread: vi.fn(), updateThread: vi.fn() };
        },
    };
});

vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useKeyboardShortcuts: () => {
            return { keyboardShortcuts: { commandPalette: "ctrl+k" } };
        },
    };
});

const RESULT_TEXT = /alpha rollout date/;
const LOADED_ONLY = /threads loaded here are filtered;/;
const BETA_TEXT = /beta cohort starts/;
const FIRST_PROJECTS_ONLY = /Only the first 1 projects are listed here/;
const LOCKED_MAY_BE_MISSING = /Locked chats do not reveal their project/;
const MEANING_FAILED = /Search by meaning failed/;
const MEANING_REFUSED = /isn't available under your account's model rules/;
const PROJECTS_FAILED = /projects could not be loaded/;
const ARCHIVED_MEANING_NOTE = /closest matches across all your threads/;

/** True when `later` comes after `earlier` in document order. */
const isBefore = (earlier: Node, later: Node): boolean => earlier.compareDocumentPosition(later) === Node.DOCUMENT_POSITION_FOLLOWING;

const messageQueries = () => harness.searchArgs.filter((args) => args !== skipToken);

const renderPalette = (queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(GlobalCommandPalette)));

/** Steps the fake clock past the search debounce (the meaning-search tests run on fake timers). */
const waitPastDebounce = async () => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
    });
};

/** The scroll area under the list needs a constructible observer; the setup's mock is an arrow function. */
const stubResizeObserver = () => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
};

const openPalette = async () => {
    act(() => {
        useCommandDialogStore.getState().openCommandPalette();
    });

    return screen.findByRole("combobox");
};

describe("command palette message search", () => {
    beforeEach(() => {
        // The scroll area under the list needs a constructible observer and jsdom lacks getAnimations; the setup's mock is an arrow function
        // and is re-installed before every test.
        Element.prototype.getAnimations = () => [];
        stubResizeObserver();
        harness.searchArgs.length = 0;
        harness.navigate.mockClear();
        harness.scrollToMessage.mockClear();
    });

    afterEach(() => {
        act(() => {
            useCommandDialogStore.getState().close();
        });
    });

    it("does not query while the palette is closed", () => {
        renderPalette();

        expect(messageQueries()).toHaveLength(0);
    });

    it("skips the query under two characters", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "a" } });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 400);
        });

        expect(messageQueries()).toHaveLength(0);
        expect(screen.queryByText("Messages")).toBeNull();
    });

    it("waits for the debounce, then lists message hits below the thread titles", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "alpha" } });

        // Typing has not paused yet.
        expect(messageQueries()).toHaveLength(0);

        const hit = await screen.findByText(RESULT_TEXT, undefined, { timeout: 3000 });

        // queryOptions is rebuilt on every render; what matters is the one query it describes.
        expect(new Set(messageQueries().map((args) => (args as { searchQuery: string }).searchQuery))).toEqual(new Set(["alpha"]));
        expect(messageQueries()[0]).toMatchObject({ paginationOpts: { cursor: null } });

        const title = screen.getByText("Alpha plan");
        const messagesLabel = screen.getByText("Messages");

        // Thread titles come first in document order.
        expect(isBefore(title, messagesLabel)).toBe(true);
        expect(isBefore(title, hit)).toBe(true);
        expect(screen.getByText("Launch notes")).toBeTruthy();
    });

    it("opens the hit's thread at the message", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "alpha" } });
        fireEvent.click(await screen.findByText(RESULT_TEXT, undefined, { timeout: 3000 }));

        await waitFor(() => expect(harness.navigate).toHaveBeenCalledTimes(1));
        expect(harness.navigate).toHaveBeenCalledWith({ hash: "message-message-9", params: { threadId: "thread-2" }, search: {}, to: "/chat/$threadId" });
        expect(harness.scrollToMessage).toHaveBeenCalledWith("message-9", { position: { order: 3, stepOrder: 0 }, threadId: "thread-2" });
    });

    it("shows no message hits while the debounce is pending", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "alpha" } });
        await screen.findByText(RESULT_TEXT, undefined, { timeout: 3000 });

        fireEvent.change(input, { target: { value: "alphab" } });

        // The input has moved on; the earlier query's hits must not stay selectable.
        expect(screen.queryByText(RESULT_TEXT)).toBeNull();
        expect(screen.queryByText("Messages")).toBeNull();
    });

    it("replaces the previous query's hits with the current query's", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "alpha" } });
        await screen.findByText(RESULT_TEXT, undefined, { timeout: 3000 });

        fireEvent.change(input, { target: { value: "beta" } });

        expect(screen.queryByText(RESULT_TEXT)).toBeNull();
        expect(await screen.findByText(BETA_TEXT, undefined, { timeout: 3000 })).toBeTruthy();
        expect(screen.queryByText(RESULT_TEXT)).toBeNull();
    });

    it("keeps a busy thread from filling every slot", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "gamma" } });

        expect(await screen.findByText("gamma quiet match", undefined, { timeout: 3000 })).toBeTruthy();
        expect(screen.getByText("gamma busy match 0")).toBeTruthy();
        // Eight slots: the quiet thread's hit takes one, so the busy thread's seventh match is cut.
        expect(screen.getByText("gamma busy match 6")).toBeTruthy();
        expect(screen.queryByText("gamma busy match 7")).toBeNull();
    });

    it("opens a highlighted message hit with Enter", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "alpha" } });
        await screen.findByText(RESULT_TEXT, undefined, { timeout: 3000 });

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(screen.getByRole("option", { name: RESULT_TEXT }).dataset.highlighted).toBeDefined();
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() => expect(harness.navigate).toHaveBeenCalledTimes(1));
        expect(harness.navigate).toHaveBeenCalledWith({ hash: "message-message-9", params: { threadId: "thread-2" }, search: {}, to: "/chat/$threadId" });
        expect(harness.scrollToMessage).toHaveBeenCalledWith("message-9", { position: { order: 3, stepOrder: 0 }, threadId: "thread-2" });
    });
});

describe("command palette state tags", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const NOW = 1_800_000_000_000;

    beforeEach(() => {
        Element.prototype.getAnimations = () => [];
        stubResizeObserver();
    });

    afterEach(() => {
        act(() => {
            useCommandDialogStore.getState().close();
        });
        harness.threads = [{ _id: "thread-1", status: "active", title: "Alpha plan" }];
        harness.hasMore = false;
        vi.useRealTimers();
    });

    it("drops a thread from #snoozed once a snooze longer than one timer allows has ended, with the palette left open", () => {
        vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
        // Thirty days: past the longest delay one timer takes, so the palette needs a second timer to see the snooze end.
        harness.threads = [{ _id: "thread-s", snoozedUntil: NOW + 30 * DAY_MS, status: "active", title: "Later plan" }];
        renderPalette();

        act(() => {
            useCommandDialogStore.getState().openCommandPalette();
        });

        fireEvent.change(screen.getByRole("combobox"), { target: { value: "#snoozed" } });

        expect(screen.getByText("Later plan")).toBeTruthy();

        act(() => {
            vi.advanceTimersByTime(25 * DAY_MS);
        });
        act(() => {
            vi.advanceTimersByTime(6 * DAY_MS);
        });

        expect(screen.queryByText("Later plan")).toBeNull();
    });

    it("says a state tag covered only the loaded threads when the list has more, and says nothing when it has all", async () => {
        harness.threads = [{ _id: "thread-w", status: "running", title: "Busy plan" }];
        harness.hasMore = true;
        const { unmount } = renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "#working" } });

        expect(screen.getByText("Busy plan")).toBeTruthy();
        expect(screen.getByText(LOADED_ONLY)).toBeTruthy();

        // Without a tag, nothing is filtered by state, so there is nothing to qualify.
        fireEvent.change(input, { target: { value: "Busy" } });
        expect(screen.queryByText(LOADED_ONLY)).toBeNull();

        unmount();
        act(() => {
            useCommandDialogStore.getState().close();
        });
        harness.hasMore = false;
        renderPalette();
        fireEvent.change(await openPalette(), { target: { value: "#working" } });

        expect(screen.queryByText(LOADED_ONLY)).toBeNull();
    });
});

describe("command palette filters and meaning search", () => {
    beforeEach(() => {
        // The debounce is stepped by hand; the clock also follows real time so Testing Library's polling still runs.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        Element.prototype.getAnimations = () => [];
        stubResizeObserver();
        harness.meaningArgs.length = 0;
        harness.searchArgs.length = 0;
    });

    afterEach(() => {
        act(() => {
            useCommandDialogStore.getState().close();
        });
        harness.threads = [{ _id: "thread-1", status: "active", title: "Alpha plan" }];
        harness.meaning = [];
        harness.meaningFails = false;
        harness.meaningRefused = false;
        harness.projects = [];
        harness.projectsHasMore = false;
        harness.projectsFail = false;
        harness.hasMore = false;
        harness.searchArgs.length = 0;
        vi.useRealTimers();
    });

    it("runs no message search under a filter, whose rows it could not show", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Threads" }));
        fireEvent.change(input, { target: { value: "alpha" } });
        await waitPastDebounce();

        expect(messageQueries()).toHaveLength(0);
    });

    it("does not send a meaning query longer than the server accepts", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "a".repeat(2001) } });
        await waitPastDebounce();

        expect(harness.meaningArgs).toHaveLength(0);
    });

    it("says an archived list covers only the loaded threads, and a project list only the first page", async () => {
        harness.hasMore = true;
        harness.projectsHasMore = true;
        harness.projects = [{ _id: "p-billing", title: "Billing" }];
        renderPalette();
        await openPalette();

        expect(screen.queryByText(LOADED_ONLY)).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Archived" }));
        expect(screen.getByText(LOADED_ONLY)).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        expect(screen.getByText(FIRST_PROJECTS_ONLY)).toBeTruthy();
    });

    it("says a failed project list failed instead of finding no projects", async () => {
        harness.threads = [];
        harness.projectsFail = true;
        renderPalette();
        await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));

        expect(screen.getByRole("alert").textContent).toMatch(PROJECTS_FAILED);
        expect(screen.queryByText("No results found.")).toBeNull();
    });

    it("picking a project found by its name clears the text, so the project's threads show", async () => {
        harness.threads = [{ _id: "thread-1a", projectId: "p-billing", status: "active", title: "Refund flow" }];
        harness.projects = [{ _id: "p-billing", title: "Billing" }];
        renderPalette();
        const input = await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        fireEvent.change(input, { target: { value: "Bill" } });
        fireEvent.click(screen.getByText("Billing"));

        expect((input as HTMLInputElement).value).toBe("");
        expect(screen.getByText("Refund flow")).toBeTruthy();
    });

    it("turning on the projects filter clears a chosen project, so the list is not left empty", async () => {
        harness.threads = [{ _id: "thread-1a", projectId: "p-billing", status: "active", title: "Refund flow" }];
        harness.projects = [{ _id: "p-billing", title: "Billing" }];
        renderPalette();
        await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        fireEvent.click(screen.getByText("Billing"));
        fireEvent.click(screen.getByRole("button", { name: "Projects" }));

        expect(screen.queryByRole("button", { name: "Project: Billing" })).toBeNull();
        expect(screen.getByText("Billing")).toBeTruthy();
    });

    it("finds 'PDF totals off by one' for 'the invoice bug' through the meaning search", async () => {
        harness.threads = [];
        harness.meaning = [{ archived: false, score: 0.82, threadId: "thread-pdf", title: "PDF totals off by one" }];
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "the invoice bug" } });

        expect(await screen.findByText("PDF totals off by one", undefined, { timeout: 3000 })).toBeTruthy();
        expect(screen.getByText("Related threads")).toBeTruthy();
        expect(harness.meaningArgs).toContainEqual({ archivedOnly: false, query: "the invoice bug" });
    });

    it("says a refused meaning search failed instead of finding nothing", async () => {
        harness.threads = [];
        harness.meaningFails = true;
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "the invoice bug" } });

        const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });

        expect(alert.textContent).toMatch(MEANING_FAILED);
        expect(screen.queryByText("No results found.")).toBeNull();
    });

    it("says the account's model rules refuse the meaning search instead of finding nothing or a passing failure", async () => {
        harness.threads = [];
        harness.meaningRefused = true;
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "the invoice bug" } });

        const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });

        expect(alert.textContent).toMatch(MEANING_REFUSED);
        expect(alert.textContent).not.toMatch(MEANING_FAILED);
        expect(screen.queryByText("No results found.")).toBeNull();
        expect(harness.meaningArgs).toHaveLength(1);
    });

    it("keeps the meaning hits when a message is sent to a thread while the palette is open", async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        harness.meaning = [{ archived: false, score: 0.82, threadId: "thread-pdf", title: "PDF totals off by one" }];
        renderPalette(queryClient);
        fireEvent.change(await openPalette(), { target: { value: "the invoice bug" } });
        await waitPastDebounce();
        expect(harness.meaningArgs).toHaveLength(1);

        await act(async () => {
            await new MutationObserver(queryClient, {
                mutationFn: async (_variables: { threadId: string }) => undefined,
                mutationKey: ["lunora", "chat_guest_links:sendHeldGuestMessage"],
            }).mutate({ threadId: "thread-pdf" });
        });
        await waitPastDebounce();

        expect(harness.meaningArgs).toHaveLength(1);
    });

    it("asks the meaning search again once a listed thread is renamed while the palette is open", async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        harness.meaning = [{ archived: false, score: 0.82, threadId: "thread-pdf", title: "PDF totals off by one" }];
        renderPalette(queryClient);
        fireEvent.change(await openPalette(), { target: { value: "the invoice bug" } });
        await waitPastDebounce();
        expect(harness.meaningArgs).toHaveLength(1);

        await act(async () => {
            await new MutationObserver(queryClient, {
                mutationFn: async (_variables: { threadId: string; title: string }) => "",
                mutationKey: ["lunora", "chat_functions:updateThread"],
            }).mutate({ threadId: "thread-pdf", title: "Renamed" });
        });

        await waitFor(() => {
            expect(harness.meaningArgs).toHaveLength(2);
        });
    });

    it("asks the archived-only meaning search again once an active thread is archived, which its hits could not list", async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        harness.meaning = [{ archived: true, score: 0.82, threadId: "thread-pdf", title: "PDF totals off by one" }];
        renderPalette(queryClient);
        const input = await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Archived" }));
        fireEvent.change(input, { target: { value: "the invoice bug" } });
        await waitPastDebounce();
        expect(harness.meaningArgs).toStrictEqual([{ archivedOnly: true, query: "the invoice bug" }]);

        await act(async () => {
            await new MutationObserver(queryClient, {
                mutationFn: async (_variables: { model: string; status: string; threadId: string }) => "",
                mutationKey: ["lunora", "chat_functions:updateThread"],
            }).mutate({ model: "gpt-4o", status: "archived", threadId: "thread-active" });
        });

        await waitFor(() => {
            expect(harness.meaningArgs).toHaveLength(2);
        });
        expect(harness.meaningArgs[1]).toStrictEqual({ archivedOnly: true, query: "the invoice bug" });
    });

    it("keeps an unfiltered meaning search's hits when a thread it does not list is archived", async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        harness.meaning = [{ archived: false, score: 0.82, threadId: "thread-pdf", title: "PDF totals off by one" }];
        renderPalette(queryClient);
        fireEvent.change(await openPalette(), { target: { value: "the invoice bug" } });
        await waitPastDebounce();
        expect(harness.meaningArgs).toHaveLength(1);

        await act(async () => {
            await new MutationObserver(queryClient, {
                mutationFn: async (_variables: { model: string; status: string; threadId: string }) => "",
                mutationKey: ["lunora", "chat_functions:updateThread"],
            }).mutate({ model: "gpt-4o", status: "archived", threadId: "thread-other" });
        });
        await waitPastDebounce();

        expect(harness.meaningArgs).toHaveLength(1);
    });

    it("lists meaning hits after the exact title matches, and does not repeat a thread the title already matched", async () => {
        harness.threads = [{ _id: "thread-x", status: "active", title: "Invoice export" }];
        harness.meaning = [
            { archived: false, score: 0.9, threadId: "thread-x", title: "Invoice export" },
            { archived: false, score: 0.7, threadId: "thread-y", title: "PDF totals off by one" },
        ];
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "invoice" } });

        const meaningHit = await screen.findByText("PDF totals off by one", undefined, { timeout: 3000 });

        expect(screen.getAllByText("Invoice export")).toHaveLength(1);
        expect(isBefore(screen.getByText("Invoice export"), meaningHit)).toBe(true);
    });

    it("picking a project keeps the Archived filter on, so the project's archived threads show", async () => {
        harness.threads = [
            { _id: "thread-1a", projectId: "p-billing", status: "active", title: "Refund flow" },
            { _id: "thread-1b", projectId: "p-billing", status: "archived", title: "Old refund run" },
        ];
        harness.projects = [{ _id: "p-billing", title: "Billing" }];
        renderPalette();
        await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Archived" }));
        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        fireEvent.click(screen.getByText("Billing"));

        expect(screen.getByText("Old refund run")).toBeTruthy();
        expect(screen.queryByText("Refund flow")).toBeNull();
        expect(screen.getByRole("button", { name: "Archived" }).getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("asks the meaning search for archived threads only under the Archived filter", async () => {
        renderPalette();
        const input = await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Archived" }));
        fireEvent.change(input, { target: { value: "the invoice bug" } });
        await waitPastDebounce();

        expect(harness.meaningArgs).toContainEqual({ archivedOnly: true, query: "the invoice bug" });
    });

    it("says archived meaning hits come from the closest matches overall, and only under the Archived filter", async () => {
        harness.threads = [];
        harness.meaning = [{ archived: true, score: 0.82, threadId: "thread-pdf", title: "PDF totals off by one" }];
        renderPalette();
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "the invoice bug" } });
        await waitPastDebounce();

        expect(screen.queryByText(ARCHIVED_MEANING_NOTE)).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Archived" }));

        expect(await screen.findByText(ARCHIVED_MEANING_NOTE, undefined, { timeout: 3000 })).toBeTruthy();
    });

    it("does not embed a query again when the text is edited back to it, and drops the hits when the palette closes", async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        renderPalette(queryClient);
        const input = await openPalette();

        fireEvent.change(input, { target: { value: "the invoice bug" } });
        await waitPastDebounce();
        fireEvent.change(input, { target: { value: "the invoice bugs" } });
        await waitPastDebounce();
        fireEvent.change(input, { target: { value: "the invoice bug" } });
        await waitPastDebounce();

        expect(harness.meaningArgs).toEqual([
            { archivedOnly: false, query: "the invoice bug" },
            { archivedOnly: false, query: "the invoice bugs" },
        ]);

        act(() => {
            useCommandDialogStore.getState().close();
        });

        await waitFor(() => {
            const kept = queryClient
                .getQueryCache()
                .findAll({ queryKey: ["command-palette", "meaning"] })
                .filter((query) => query.state.data !== undefined);

            expect(kept).toHaveLength(0);
        });
    });

    it("the projects filter lists project rows only, and choosing one narrows the threads to that project", async () => {
        harness.threads = [
            { _id: "thread-1a", projectId: "p-billing", status: "active", title: "Refund flow" },
            { _id: "thread-2a", projectId: "p-other", status: "active", title: "Other chat" },
        ];
        harness.projects = [{ _id: "p-billing", title: "Billing" }];
        renderPalette();
        await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));

        expect(screen.getByText("Billing")).toBeTruthy();
        expect(screen.queryByText("Refund flow")).toBeNull();
        expect(screen.queryByText("Go to Chat")).toBeNull();

        fireEvent.click(screen.getByText("Billing"));

        expect(screen.getByText("Refund flow")).toBeTruthy();
        expect(screen.queryByText("Other chat")).toBeNull();
        expect(screen.getByRole("button", { name: "Project: Billing" })).toBeTruthy();
    });

    it("says locked chats may be missing under a chosen project, whose stubs carry no project", async () => {
        harness.threads = [
            { _id: "thread-1a", projectId: "p-billing", status: "active", title: "Refund flow" },
            { _id: "thread-locked", lockedAt: 1, status: "active" },
        ];
        harness.projects = [{ _id: "p-billing", title: "Billing" }];
        renderPalette();
        await openPalette();

        expect(screen.queryByText(LOCKED_MAY_BE_MISSING)).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        fireEvent.click(screen.getByText("Billing"));

        expect(screen.getByText("Refund flow")).toBeTruthy();
        expect(screen.getByText(LOCKED_MAY_BE_MISSING)).toBeTruthy();
    });

    it("says nothing about locked chats under a project when none are loaded", async () => {
        harness.threads = [{ _id: "thread-1a", projectId: "p-billing", status: "active", title: "Refund flow" }];
        harness.projects = [{ _id: "p-billing", title: "Billing" }];
        renderPalette();
        await openPalette();

        fireEvent.click(screen.getByRole("button", { name: "Projects" }));
        fireEvent.click(screen.getByText("Billing"));

        expect(screen.getByText("Refund flow")).toBeTruthy();
        expect(screen.queryByText(LOCKED_MAY_BE_MISSING)).toBeNull();
    });
});

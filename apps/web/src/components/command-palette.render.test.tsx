/**
 * Message search in the command palette: it waits for two characters and a
 * pause in typing, shows its hits below the thread-title groups, and opens the
 * hit's thread at the message.
 */

import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
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
    };
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
                                { _id: "thread-quiet", relevantMessages: [{ _id: "quiet-0", order: 1, stepOrder: 0, text: "gamma quiet match" }], title: "Quiet thread" },
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
        useCRPC: () => {
            return { chat: { functions: { getPinnedThreads: pinned, searchMessages } } };
        },
        useLunoraAuth: () => {
            return { isAuthenticated: true, isLoading: false };
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
            return { lunora: [{ _id: "thread-1", status: "active", title: "Alpha plan" }] };
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
const BETA_TEXT = /beta cohort starts/;

/** True when `later` comes after `earlier` in document order. */
const isBefore = (earlier: Node, later: Node): boolean => earlier.compareDocumentPosition(later) === Node.DOCUMENT_POSITION_FOLLOWING;

const messageQueries = () => harness.searchArgs.filter((args) => args !== skipToken);

const renderPalette = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(createElement(QueryClientProvider, { client: queryClient }, createElement(GlobalCommandPalette)));
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
        vi.stubGlobal(
            "ResizeObserver",
            class {
                disconnect = vi.fn();

                observe = vi.fn();

                unobserve = vi.fn();
            },
        );
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

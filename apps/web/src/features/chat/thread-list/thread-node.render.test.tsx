// @vitest-environment jsdom

/** The row's hover actions are icon-only buttons; each needs an accessible name of its own. */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearComposerDrafts, saveComposerDraft } from "@/features/chat/split/composer-drafts";
import { useSplitLayoutStore } from "@/features/chat/split/split-layout-store";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

const LINKED_PULL_REQUESTS = /Linked pull requests/u;

const navigate = vi.hoisted(() => vi.fn());

const linkedPullRequests = vi.hoisted(() => {
    return { count: 0 };
});

vi.mock("@lingui/core/macro", () => {
    return { msg: (strings: TemplateStringsArray) => strings[0] };
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
    return { api: { chat: { functions: { regenerateThreadTitle: {}, updateThread: {} } } } };
});

vi.mock("@/features/develop/components/pull-request-counts", () => {
    return {
        usePullRequestCount: () => linkedPullRequests.count,
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

vi.mock("@tanstack/react-router", () => {
    return {
        // The thread title is a router link (#548); it renders as a plain anchor here.
        Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
        useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) => {
            const location = { pathname: "/chat" };

            return options?.select ? options.select(location) : location;
        },
        useRouter: () => {
            return { navigate, preloadRoute: async () => {}, state: { location: { pathname: "/chat" } } };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const entry = {
        mutationOptions: () => {
            return {};
        },
        queryKey: () => [],
    };

    return {
        createLunoraQueryOptions: () => {
            return {};
        },
        useLunoraActionOptions: () => {
            return {};
        },
        useCRPC: () => {
            return {
                agent: { thread_lock: { lockThread: entry } },
                chat: {
                    functions: { abortThreadStream: entry, convertTemporaryToPermanent: entry, getThread: entry, regenerateThreadTitle: entry },
                    thread_state: { snoozeThread: entry, unsnoozeThread: entry },
                },
            };
        },
        useLunora: () => {
            return {};
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

vi.mock("@/lib/toast", () => {
    return { showError: () => {}, showSuccess: () => {} };
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

vi.mock("./sortable-thread-item", () => {
    return { default: vi.fn(() => null) };
});

/** The thread whose options menu the list has open, as the context-menu key sets it. */
const uiState = vi.hoisted(() => {
    return { optionsMenuThreadId: null as string | null };
});

vi.mock("./stores/thread-list-ui-store", () => {
    return {
        selectSetShowManageTagsDialog: () => {},
        useThreadListUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
            selector({ optionsMenuThreadId: uiState.optionsMenuThreadId, setOptionsMenuThreadId: () => {}, setRenameThreadId: () => {} }),
    };
});

const { default: ThreadNode } = await import("./thread-node");
const { KeyboardSelectionProvider } = await import("./contexts/keyboard-selection-context");

const SNOOZE_BUTTON = /^Snooze thread/u;
const TOUCH_CLASSES = /pointer-coarse|hover:none/u;

const child = { branchPoint: 0, branchType: "branch", children: [], createdAt: 0, depth: 1, status: "idle", threadId: "c1", title: "Child" };

const baseProps = {
    expandedThreads: new Set<string>(),
    handleCreateBranch: () => {},
    handleDeleteThread: () => {},
    handleDownloadThread: () => {},
    handlePinThread: () => {},
    handleThreadToggle: () => {},
    handleUnpinThread: () => {},
    isSelected: false,
    isSelectionMode: false,
    loadingStates: {
        archiving: new Set<string>(),
        branching: new Set<string>(),
        deleting: new Set<string>(),
        downloading: new Set<string>(),
        pinning: new Set<string>(),
        reordering: false,
    },
    node: {
        branchPoint: 0,
        branchType: "root",
        children: [child],
        createdAt: 0,
        depth: 0,
        expiresAt: Date.now() + 3_600_000,
        status: "idle",
        threadId: "t1",
        title: "Quarterly plan",
    },
    searchQuery: "",
    selectedThreadIds: new Set<string>(),
    toggleExpanded: () => {},
    updateThread: () => {},
};

describe("ThreadNode", () => {
    it("shows the linked pull request count with an accessible label, and none for a thread with no link", () => {
        linkedPullRequests.count = 2;
        const { unmount } = render(<ThreadNode {...baseProps} />);

        expect(screen.getByLabelText("Linked pull requests: 2").textContent).toContain("2");
        unmount();

        linkedPullRequests.count = 0;
        render(<ThreadNode {...baseProps} />);

        expect(screen.queryByLabelText(LINKED_PULL_REQUESTS)).toBeNull();
        linkedPullRequests.count = 0;
    });

    it.each([
        "Expand branches",
        "Pin thread",
        "Create branch",
        "Move to project",
        "Download thread",
        "Archive thread",
        "Convert to permanent",
        "Delete thread",
    ])("names the %s button after its thread", (action) => {
        render(<ThreadNode {...baseProps} />);

        expect(screen.getByRole("button", { name: `${action}: Quarterly plan` })).toBeTruthy();
    });

    it("offers a snooze on a root thread that has a reply, and none on a child", () => {
        const replied = { ...baseProps.node, lastReplyAt: 1 };
        const { rerender } = render(<ThreadNode {...baseProps} node={replied} />);

        expect(screen.getByRole("button", { name: "Snooze thread: Quarterly plan" })).toBeTruthy();

        rerender(<ThreadNode {...baseProps} node={{ ...child, lastReplyAt: 1 }} />);

        expect(screen.queryByRole("button", { name: SNOOZE_BUTTON })).toBeNull();
    });

    it("marks itself when the list's arrow keys select it, and not when they select another row", () => {
        const { container, rerender } = render(
            <KeyboardSelectionProvider threadId="t1">
                <ThreadNode {...baseProps} />
            </KeyboardSelectionProvider>,
        );

        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the highlight is only a class
        expect(container.querySelector(`[data-thread-id="t1"]`)?.className).toContain("ring-white/50");

        rerender(
            <KeyboardSelectionProvider threadId="c1">
                <ThreadNode {...baseProps} />
            </KeyboardSelectionProvider>,
        );

        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the highlight is only a class
        expect(container.querySelector(`[data-thread-id="t1"]`)?.className).not.toContain("ring-white/50");
    });

    describe("when its chat is a split view pane", () => {
        const setSplit = (enabled: boolean, panes: string[], focus: number) => {
            useUIStateStore.setState((state) => {
                return { preferences: { ...state.preferences, splitViewEnabled: enabled } };
            });
            useSplitLayoutStore.setState({ layout: { focus, panes, sizes: {} } });
        };

        afterEach(() => {
            cleanup();
            setSplit(false, [], 0);
            clearComposerDrafts();
        });

        // eslint-disable-next-line testing-library/no-node-access -- the row root carries the data attribute
        const rowOf = () => screen.getByText("Quarterly plan").closest("[data-split-open], [role=presentation]");

        it("marks the row and labels the marker, so the state is not colour alone", () => {
            setSplit(true, ["t1", "t9"], 1);
            render(<ThreadNode {...baseProps} />);

            expect(screen.getByRole("img", { name: "Open in split view" })).toBeTruthy();
            expect(rowOf()?.hasAttribute("data-split-open")).toBe(true);
        });

        it("shows no marker for a chat that is not a pane, or while the split view preference is off", () => {
            setSplit(true, ["t9"], 0);
            const { unmount } = render(<ThreadNode {...baseProps} />);

            expect(screen.queryByRole("img", { name: "Open in split view" })).toBeNull();
            expect(rowOf()?.hasAttribute("data-split-open")).toBe(false);
            unmount();

            setSplit(false, ["t1"], 0);
            render(<ThreadNode {...baseProps} />);

            expect(screen.queryByRole("img", { name: "Open in split view" })).toBeNull();
            expect(rowOf()?.hasAttribute("data-split-open")).toBe(false);
        });

        it("marks a chat with a parked draft, and only while the split view preference is on", () => {
            setSplit(true, ["t9"], 0);
            saveComposerDraft("t1", { composerText: "unsent" });
            const { unmount } = render(<ThreadNode {...baseProps} />);

            expect(rowOf()?.hasAttribute("data-draft")).toBe(true);
            expect(screen.getByText("Draft")).toBeTruthy();
            unmount();

            setSplit(true, ["t9"], 0);
            clearComposerDrafts();
            render(<ThreadNode {...baseProps} />);

            expect(rowOf()?.hasAttribute("data-draft")).toBe(false);
            expect(screen.queryByText("Draft")).toBeNull();
            cleanup();

            setSplit(false, ["t9"], 0);
            saveComposerDraft("t1", { composerText: "unsent" });
            render(<ThreadNode {...baseProps} />);

            expect(rowOf()?.hasAttribute("data-draft")).toBe(false);
            expect(screen.queryByText("Draft")).toBeNull();
        });

        it("focuses the pane on a click, and leaves focus alone on a Ctrl-click", () => {
            setSplit(true, ["t1", "t9"], 1);
            render(<ThreadNode {...baseProps} />);

            fireEvent.click(screen.getByText("Quarterly plan"), { ctrlKey: true });

            expect(useSplitLayoutStore.getState().layout.focus).toBe(1);

            fireEvent.click(screen.getByText("Quarterly plan"));

            expect(useSplitLayoutStore.getState().layout.focus).toBe(0);
        });

        it("navigates to a chat that is not the page's, so the split view focuses its pane on the route change", () => {
            setSplit(true, ["t1", "t9"], 1);
            render(<ThreadNode {...baseProps} />);

            fireEvent.click(rowOf() as HTMLElement);

            expect(navigate).toHaveBeenCalledWith({ params: { threadId: "t1" }, search: {}, to: "/chat/$threadId" });
        });
    });

    it("flips the expand label and state when the branches are open", () => {
        render(<ThreadNode {...baseProps} expandedThreads={new Set(["t1"])} />);

        expect(screen.getByRole("button", { expanded: true, name: "Collapse branches: Quarterly plan" })).toBeTruthy();
    });

    it("announces a thread that starts waiting for the user, and clears when it stops", () => {
        const { rerender } = render(<ThreadNode {...baseProps} />);
        const region = screen.getByRole("status");

        expect(region.textContent).toBe("");

        rerender(<ThreadNode {...baseProps} node={{ ...baseProps.node, awaitingInput: "approval" }} />);

        expect(screen.getByRole("status")).toBe(region);
        expect(region.textContent).toBe("Waiting for your approval");

        rerender(<ThreadNode {...baseProps} node={{ ...baseProps.node, awaitingInput: "question" }} />);

        expect(region.textContent).toBe("Waiting for your answer");
    });

    /* eslint-disable testing-library/no-node-access -- where a control sits relative to the hover-only strip, and its classes, are what these assert */
    it("shows the options menu outside the hover-only action strip on a touch screen, and keeps the strip itself hidden", () => {
        render(<ThreadNode {...baseProps} />);

        const [touch, strip] = screen.getAllByRole("button", { name: "Thread options: Quarterly plan" });
        const touchWrapper = touch?.closest("span[role=presentation]");
        const stripWrapper = strip?.closest("span[role=presentation]");

        // The touch copy is not inside the strip, whose opacity would hide it; each copy shows only where the other does not.
        expect(touchWrapper?.className).toContain("[@media(hover:none)]:contents");
        expect(touchWrapper?.closest(".opacity-0")).toBeNull();
        expect(stripWrapper?.className).toContain("[@media(hover:none)]:hidden");
        expect(stripWrapper?.closest(".opacity-0")).not.toBeNull();
    });

    it("keeps the touch-screen classes off the action strip, so it never covers the title", () => {
        render(<ThreadNode {...baseProps} />);

        const strip = screen.getByRole("button", { name: "Archive thread: Quarterly plan" }).closest(".absolute");

        expect(strip?.className).toContain("opacity-0");
        expect(strip?.className).not.toMatch(TOUCH_CLASSES);
    });
    /* eslint-enable testing-library/no-node-access */

    it.each([
        ["a screen with hover", true],
        ["a touch screen", false],
    ])("opens one options menu, never both copies, on %s", (_screen, hover) => {
        const matchMedia = vi.fn((query: string) => {
            return { addEventListener: () => {}, matches: query === "(hover: hover)" && hover, removeEventListener: () => {} };
        });

        vi.stubGlobal("matchMedia", matchMedia);
        // An open menu positions itself with a ResizeObserver, which it constructs.
        vi.stubGlobal(
            "ResizeObserver",
            // A constructor mock must be a `function`, not an arrow.
            // eslint-disable-next-line prefer-arrow-callback
            vi.fn(function ResizeObserverStub() {
                return { disconnect: vi.fn(), observe: vi.fn(), unobserve: vi.fn() };
            }),
        );
        uiState.optionsMenuThreadId = "t1";

        try {
            render(<ThreadNode {...baseProps} />);

            expect(screen.getAllByRole("menuitem", { name: "Rename" })).toHaveLength(1);
        } finally {
            uiState.optionsMenuThreadId = null;
            vi.unstubAllGlobals();
        }
    });
});

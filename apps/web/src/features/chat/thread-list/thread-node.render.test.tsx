// @vitest-environment jsdom

/** The row's quick actions are icon-only buttons and the rest are menu items; each needs an accessible name of its own. */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearComposerDrafts, saveComposerDraft } from "@/features/chat/split/composer-drafts";
import { useSplitLayoutStore } from "@/features/chat/split/split-layout-store";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { GroupProjectContext, ThreadRowHintsContext } from "./contexts/thread-row-hints-context";

const LINKED_PULL_REQUESTS = /Linked pull requests/u;
const PROJECT_NAME = /Q1 Launch/u;
const PROJECT_OR_MODEL = /Q1 Launch|deep-model-2/u;

const navigate = vi.hoisted(() => vi.fn());

const linkedPullRequests = vi.hoisted(() => {
    return { count: 0 };
});

// The options menu reads the follow state; these tests are about the row, not the follow items.
vi.mock("../follows/use-thread-follow", () => {
    return {
        useThreadFollow: () => {
            return { error: null, isPending: false, setState: () => {}, state: undefined };
        },
    };
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
    return { api: { chat: { functions: { regenerateThreadTitle: {}, updateThread: {} }, side_chat: { createSideChat: {} } } } };
});

vi.mock("@/features/develop/components/pull-request-counts", () => {
    return {
        usePullRequestCount: () => linkedPullRequests.count,
    };
});

/** The branch toggle's name starts with its visible count ("2 branches, …"), so it is matched by its end. */
const EXPAND_BRANCHES_NAME = /Expand branches: Quarterly plan$/u;
const COLLAPSE_BRANCHES_NAME = /Collapse branches: Quarterly plan$/u;

// The row reads the model name from the cached gateway catalog; these tests have none.
vi.mock("@/hooks/use-cached-model-name", () => {
    return { default: (): undefined => undefined };
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
        useNavigate: () => navigate,
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

const userSettings = vi.hoisted(() => {
    return { value: undefined as Record<string, boolean> | undefined };
});

vi.mock("./hooks/use-confirm-before-delete", () => {
    return {
        useConfirmBeforeDelete: () => userSettings.value?.confirmBeforeDeleteChat !== false,
    };
});

// Shows its confirm button only while open, as the real dialog is shown only when a delete asks first.
vi.mock("@/components/delete-confirmation-dialog", () => {
    return {
        default: ({ onConfirm, open }: { onConfirm: () => void; open: boolean }) =>
            open ? (
                <button onClick={onConfirm} type="button">
                    Confirm delete
                </button>
            ) : null,
    };
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

// A fixed minute, so a time label does not depend on when the test runs.
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

vi.mock("./hooks/use-minute-clock", () => {
    return { default: () => NOW };
});

vi.mock("@/features/chat/tags/thread-tag-chips", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/tags/thread-tags-menu", () => {
    return { ThreadTagsMenuItems: () => null, default: () => null };
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

/** Set while a test acts as an admin impersonating the signed-in user. */
const impersonation = vi.hoisted(() => {
    return { active: false };
});

vi.mock("@/features/admin/hooks/use-is-impersonating", () => {
    return { useImpersonating: () => impersonation.active };
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

/** Renders the row with its options menu open, as the context-menu key leaves it; the row's actions are items in it. */
const renderWithMenu = (ui: React.ReactElement) => {
    const matchMedia = vi.fn((query: string) => {
        return { addEventListener: () => {}, matches: query === "(hover: hover)", removeEventListener: () => {} };
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

    return render(ui);
};
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

/** The thread list beside the row, which takes the row away when it is deleted, as the optimistic deletion does. */
const RowHost = () => {
    const [deleted, setDeleted] = useState(false);

    return (
        <>
            <button data-search-toggle="" type="button">
                Search threads
            </button>
            {!deleted && <ThreadNode {...baseProps} handleDeleteThread={() => setDeleted(true)} />}
        </>
    );
};

describe("ThreadNode delete confirmation", () => {
    beforeEach(() => {
        userSettings.value = undefined;
    });

    afterEach(() => {
        cleanup();
        uiState.optionsMenuThreadId = null;
        vi.unstubAllGlobals();
    });

    it("asks first by default, and deletes only once the dialog is confirmed", () => {
        const handleDeleteThread = vi.fn();

        renderWithMenu(<ThreadNode {...baseProps} handleDeleteThread={handleDeleteThread} />);

        fireEvent.click(screen.getByRole("menuitem", { name: "Delete thread: Quarterly plan" }));

        expect(handleDeleteThread).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

        expect(handleDeleteThread).toHaveBeenCalledWith("t1");
    });

    it("deletes at once, with no dialog, when the setting is saved as off", () => {
        userSettings.value = { confirmBeforeDeleteChat: false };
        const handleDeleteThread = vi.fn();

        renderWithMenu(<ThreadNode {...baseProps} handleDeleteThread={handleDeleteThread} />);

        fireEvent.click(screen.getByRole("menuitem", { name: "Delete thread: Quarterly plan" }));

        expect(handleDeleteThread).toHaveBeenCalledWith("t1");
        expect(screen.queryByRole("button", { name: "Confirm delete" })).toBeNull();
    });

    it("moves focus to the search toggle when a delete at once takes the focused row away", async () => {
        userSettings.value = { confirmBeforeDeleteChat: false };

        renderWithMenu(<RowHost />);

        const deleteItem = screen.getByRole("menuitem", { name: "Delete thread: Quarterly plan" });

        deleteItem.focus();
        fireEvent.click(deleteItem);

        // The menu hands focus back to its trigger as it closes; the toggle takes it again once that has happened.
        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search threads" })));
    });

    it("moves focus to the search toggle after a confirmed delete, since the row's item that opened the dialog leaves", async () => {
        renderWithMenu(<RowHost />);

        fireEvent.click(screen.getByRole("menuitem", { name: "Delete thread: Quarterly plan" }));
        fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search threads" })));
    });
});

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

    it.each(["Expand branches", "Pin thread", "Archive thread"])("names the %s button after its thread", (action) => {
        render(<ThreadNode {...baseProps} />);

        // The branch toggle's name starts with its visible count, so it is matched by its end.
        expect(screen.getByRole("button", { name: new RegExp(`${action}: Quarterly plan$`) })).toBeTruthy();
    });

    it("keeps only Pin, Snooze, Archive and the options menu as quick actions, and no old icon button", () => {
        render(<ThreadNode {...baseProps} node={{ ...baseProps.node, lastReplyAt: 1 }} />);

        for (const action of ["Create branch", "Move to project", "Download thread", "Convert to permanent", "Delete thread", "Chat lock"]) {
            expect(screen.queryByRole("button", { name: `${action}: Quarterly plan` })).toBeNull();
        }

        for (const action of ["Pin thread", "Snooze thread", "Archive thread"]) {
            expect(screen.getByRole("button", { name: `${action}: Quarterly plan` })).toBeTruthy();
        }
    });

    describe("with its options menu open", () => {
        afterEach(() => {
            cleanup();
            uiState.optionsMenuThreadId = null;
            vi.unstubAllGlobals();
        });

        it.each(["Create branch", "Move to project", "Download thread", "Convert to permanent", "Delete thread", "Chat lock"])(
            "holds %s as a menu item named after its thread",
            (action) => {
                renderWithMenu(<ThreadNode {...baseProps} />);

                expect(screen.getByRole("menuitem", { name: `${action}: Quarterly plan` })).toBeTruthy();
            },
        );

        it("holds the tags as a submenu on a permanent chat, and an inert item that says why on a temporary one", () => {
            const { unmount } = renderWithMenu(<ThreadNode {...baseProps} />);

            expect(screen.getByRole("menuitem", { name: "Tags unavailable for temporary chats: Quarterly plan" })).toBeTruthy();
            unmount();

            renderWithMenu(<ThreadNode {...baseProps} node={{ ...baseProps.node, expiresAt: undefined }} />);

            expect(screen.getByRole("menuitem", { name: "Tags for Quarterly plan" })).toBeTruthy();
        });

        it("hides archive, delete and the lock menu from an admin impersonating the owner, as the server refuses them", () => {
            impersonation.active = true;
            renderWithMenu(<ThreadNode {...baseProps} />);
            impersonation.active = false;

            expect(screen.queryByRole("button", { name: "Archive thread: Quarterly plan" })).toBeNull();

            for (const action of ["Delete thread", "Chat lock"]) {
                expect(screen.queryByRole("menuitem", { name: `${action}: Quarterly plan` })).toBeNull();
            }

            expect(screen.getByRole("menuitem", { name: "Download thread: Quarterly plan" })).toBeTruthy();
        });

        it("keeps the lock menu for an admin impersonating the owner of a locked chat, so they can still unlock it to read", () => {
            impersonation.active = true;
            renderWithMenu(<ThreadNode {...baseProps} node={{ ...baseProps.node, lockedAt: 1 }} />);
            impersonation.active = false;

            expect(screen.getByRole("menuitem", { name: "Chat lock: locked: Locked chat" })).toBeTruthy();
        });
    });

    it("words the time since the last activity in short form, in the title's line", () => {
        render(<ThreadNode {...baseProps} node={{ ...baseProps.node, updatedAt: NOW - 5 * 60_000 }} />);

        expect(screen.getByText("5m")).toBeTruthy();
    });

    it("puts what is attached to the thread in a second line: branches, host runner and linked pull requests", () => {
        linkedPullRequests.count = 3;
        render(<ThreadNode {...baseProps} node={{ ...baseProps.node, runner: "host" }} />);
        linkedPullRequests.count = 0;

        expect(screen.getByText("Runs on your computer")).toBeTruthy();
        expect(screen.getByLabelText("Linked pull requests: 3")).toBeTruthy();
        expect(screen.getByRole("button", { name: EXPAND_BRANCHES_NAME })).toBeTruthy();
    });

    describe("with a detail in the second line", () => {
        const plain = { ...baseProps.node, children: [], expiresAt: undefined };
        const DEFAULT = "acme/fast-model-1";
        const OTHER = "acme/deep-model-2";

        /** The row as the list renders it: the hints the list answered once, and the project section the row sits in. */
        const renderIn = (node: object, { defaultModels = [DEFAULT], group }: { defaultModels?: string[] | null; group?: string } = {}) =>
            render(
                <ThreadRowHintsContext
                    value={{ defaultModels: defaultModels === null ? undefined : new Set(defaultModels), projectTitles: new Map([["p1", "Q1 Launch"]]) }}
                >
                    <GroupProjectContext value={group}>
                        <ThreadNode {...baseProps} node={{ ...plain, ...node }} />
                    </GroupProjectContext>
                </ThreadRowHintsContext>,
            );

        it("says nothing for a plain chat on the default model, so no row repeats the model every other row has", () => {
            renderIn({ model: DEFAULT });

            expect(screen.queryByText("fast-model-1")).toBeNull();
            expect(screen.queryByText("Claude Sonnet 4.5")).toBeNull();
        });

        it("names the model when it is not the default", () => {
            renderIn({ model: OTHER });

            expect(screen.getByText("deep-model-2")).toBeTruthy();
        });

        it("says nothing for an image chat on the user's image default, which is a default of its own kind", () => {
            renderIn({ model: OTHER }, { defaultModels: [DEFAULT, OTHER] });

            expect(screen.queryByText("deep-model-2")).toBeNull();
        });

        it("names no model before the default is known, so none shows and goes", () => {
            renderIn({ model: OTHER }, { defaultModels: null });

            expect(screen.queryByText("deep-model-2")).toBeNull();
        });

        it("follows the agent a thread was switched to, not the model it was created on", () => {
            renderIn({ activeAgent: { model: DEFAULT }, model: OTHER });

            expect(screen.queryByText("deep-model-2")).toBeNull();
        });

        it("says Auto for a thread on Auto", () => {
            renderIn({ autoModel: true, model: DEFAULT });

            expect(screen.getByText("Auto")).toBeTruthy();
        });

        it("names the project of a row that sits outside its project's section, with the model when that differs", () => {
            renderIn({ model: OTHER, projectId: "p1" });

            expect(screen.getByText("Q1 Launch · deep-model-2")).toBeTruthy();
        });

        it("leaves the project out inside its own section, which names it already", () => {
            renderIn({ model: DEFAULT, projectId: "p1" }, { group: "p1" });

            expect(screen.queryByText(PROJECT_NAME)).toBeNull();
        });

        it("names the project of a thread on your computer and not its model, which is the coding agent's", () => {
            renderIn({ model: OTHER, projectId: "p1", runner: "host" });

            expect(screen.getByText("Runs on your computer")).toBeTruthy();
            expect(screen.getByText("Q1 Launch")).toBeTruthy();
            expect(screen.queryByText("deep-model-2")).toBeNull();
        });

        it("shows nothing about a locked chat", () => {
            renderIn({ lockedAt: 1, model: OTHER, projectId: "p1" });

            expect(screen.queryByText(PROJECT_OR_MODEL)).toBeNull();
        });
    });

    it("lifts the open thread's card and indents a branch", () => {
        const { container, rerender } = render(<ThreadNode {...baseProps} />);

        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the surfaces are only classes on the card
        const card = (id: string) => container.querySelector(`[data-thread-id="${CSS.escape(id)}"]`)?.classList;

        expect(card("t1")?.contains("bg-surface-row")).toBe(true);
        expect(card("t1")?.contains("ml-4")).toBe(false);

        rerender(<ThreadNode {...baseProps} node={{ ...child }} />);

        expect(card("c1")?.contains("ml-4")).toBe(true);
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
        expect(container.querySelector(`[data-thread-id="t1"]`)?.classList.contains("ring-2")).toBe(true);

        rerender(
            <KeyboardSelectionProvider threadId="c1">
                <ThreadNode {...baseProps} />
            </KeyboardSelectionProvider>,
        );

        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the highlight is only a class
        expect(container.querySelector(`[data-thread-id="t1"]`)?.classList.contains("ring-2")).toBe(false);
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

        expect(screen.getByRole("button", { expanded: true, name: COLLAPSE_BRANCHES_NAME })).toBeTruthy();
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

    it("keeps a streaming row's stop button in reach on a touch screen, outside the hover-only strip", () => {
        render(<ThreadNode {...baseProps} node={{ ...baseProps.node, status: "running" }} />);

        const [touch, strip] = screen.getAllByRole("button", { name: "Stop generating: Quarterly plan" });

        expect(strip?.closest("span[role=presentation]")?.className).toContain("[@media(hover:none)]:hidden");
        expect(strip?.closest(".opacity-0")).not.toBeNull();
        expect(touch?.closest("span[role=presentation]")?.className).toContain("[@media(hover:none)]:contents");
        expect(touch?.closest(".opacity-0")).toBeNull();
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

    it.each([
        ["offers pin and archive in the row menu on a touch screen, which has no hover strip", false, 1],
        ["leaves them to the hover strip on a screen with hover", true, 0],
    ])("%s", (_case, hover, count) => {
        vi.stubGlobal(
            "matchMedia",
            vi.fn((query: string) => {
                return { addEventListener: () => {}, matches: query === "(hover: hover)" && hover, removeEventListener: () => {} };
            }),
        );
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

            expect(screen.queryAllByRole("menuitem", { name: "Pin thread" })).toHaveLength(count);
            expect(screen.queryAllByRole("menuitem", { name: "Archive thread" })).toHaveLength(count);
        } finally {
            uiState.optionsMenuThreadId = null;
            vi.unstubAllGlobals();
        }
    });
});

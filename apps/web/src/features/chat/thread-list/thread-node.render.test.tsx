// @vitest-environment jsdom

/** The row's hover actions are icon-only buttons; each needs an accessible name of its own. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const LINKED_PULL_REQUESTS = /Linked pull requests/u;

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
        useLocation: () => {
            return { pathname: "/chat" };
        },
        useRouter: () => {
            return { navigate: () => {}, preloadRoute: async () => {} };
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
    return { default: () => null };
});

vi.mock("./stores/thread-list-ui-store", () => {
    return { selectSetShowManageTagsDialog: () => {}, useThreadListUIStore: () => () => {} };
});

const { default: ThreadNode } = await import("./thread-node");

const SNOOZE_BUTTON = /^Snooze thread/u;
const TOUCH_CLASSES = /pointer-coarse|hover:none/u;

const child = { branchPoint: 0, branchType: "branch", children: [], createdAt: 0, depth: 1, status: "idle", threadId: "c1", title: "Child" };

const baseProps = {
    currentThreadId: undefined,
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
});

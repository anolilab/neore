// @vitest-environment jsdom

/** A drop shows the list's reordering state while the save runs and clears it afterwards, whether the save worked or not. */
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadingStates, ThreadGroup } from "./types";

const harness = vi.hoisted(() => {
    return {
        applyDragEnd: vi.fn(),
        onDragEnd: undefined as ((event: unknown) => Promise<void>) | undefined,
        showError: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: () => null,
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

// The drop is fired through the handler the list gives `DndContext`; jsdom cannot run a pointer drag.
vi.mock("@dnd-kit/core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
    return {
        ...(await importOriginal()),
        DndContext: ({ onDragEnd }: { children: ReactNode; onDragEnd: (event: unknown) => Promise<void> }) => {
            harness.onDragEnd = onDragEnd;

            return null;
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { mutateAsync: vi.fn() };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => () => {} };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    functions: {
                        updateThreadOrder: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: harness.showError, showInfo: vi.fn() };
});

vi.mock("@/features/projects/hooks/use-projects", () => {
    const mutation = () => {
        return { mutateAsync: vi.fn() };
    };

    return {
        useDeleteProject: mutation,
        useMoveThreadToProject: mutation,
        usePinProject: mutation,
        useProjects: () => [],
        useUnpinProject: mutation,
        useUpdateProjectOrder: mutation,
    };
});

vi.mock("@/features/develop/components/pull-request-counts", () => {
    return { PullRequestCountsProvider: ({ children }: { children: ReactNode }) => children };
});

vi.mock("@/components/delete-confirmation-dialog", () => {
    return { default: () => null };
});

const groups: ThreadGroup[] = [
    {
        groupType: "today",
        threads: [
            { children: [], threadId: "t1" },
            { children: [], threadId: "t2" },
        ],
        title: "Today",
    } as unknown as ThreadGroup,
];

vi.mock("./hooks/use-thread-groups", () => {
    return {
        default: () => {
            return { isPlaceholderData: false, threadGroups: groups, threadsData: [] };
        },
    };
});

vi.mock("./hooks/use-thread-handlers", () => {
    return {
        default: () => {
            return {};
        },
    };
});

vi.mock("./hooks/use-keyboard-navigation", () => {
    return {
        default: () => {
            return { isKeyboardNavigating: false, selectedThreadIndex: -1 };
        },
    };
});

vi.mock("./hooks/use-thread-list-keyboard", () => {
    return { default: () => {} };
});

vi.mock("./components/thread-group-renderer", () => {
    return { default: () => null };
});

vi.mock("./sortable-thread-item", () => {
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

vi.mock("./apply-drag-end", () => {
    return { default: harness.applyDragEnd };
});

const { default: HierarchicalThreadList } = await import("./hierarchical-thread-list");

/** The list under the state `ThreadList` owns for it, with the reordering flag shown as the row spinner shows it. */
const Harness = () => {
    const [loadingStates, setLoadingStates] = useState<LoadingStates>({
        archiving: new Set(),
        branching: new Set(),
        deleting: new Set(),
        downloading: new Set(),
        pinning: new Set(),
        reordering: false,
    });

    return (
        <>
            <output data-testid="reordering">{loadingStates.reordering ? "reordering" : "idle"}</output>
            <HierarchicalThreadList
                collapsedGroups={new Set()}
                collapsedProjects={new Set()}
                currentThreadId={undefined}
                expandedThreads={new Set()}
                isSearchLoading={false}
                isSelectionMode={false}
                lastSelectedIndex={-1}
                loadingStates={loadingStates}
                messageSearchResults={undefined}
                onExitSelectionMode={() => {}}
                searchQuery=""
                searchType="threads"
                selectedThreadIds={new Set()}
                setLastSelectedIndex={() => {}}
                setLoadingStates={setLoadingStates}
                setSelectedThreadIds={() => {}}
                setShowKeyboardHelp={() => {}}
                showKeyboardHelp={false}
                threadRelationships={[]}
                threadSearchResults={undefined}
                toggleExpanded={() => {}}
                toggleGroupCollapsed={() => {}}
            />
        </>
    );
};

/** Drops `t2` on `t1` and lets the save settle, returning what the reordering flag showed while it ran. */
const dropAndSettle = async (settleSave: (save: { reject: (error: Error) => void; resolve: () => void }) => void): Promise<string | null> => {
    let save!: { reject: (error: Error) => void; resolve: () => void };

    harness.applyDragEnd.mockImplementationOnce(
        () =>
            new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
                save = { reject, resolve };
            }),
    );

    let drop!: Promise<void>;

    act(() => {
        drop = harness.onDragEnd!({ active: { id: "t2" }, over: { id: "t1" } });
    });

    const duringSave = screen.getByTestId("reordering").textContent;

    await act(async () => {
        settleSave(save);
        await drop;
    });

    return duringSave;
};

describe("hierarchicalThreadList drag end", () => {
    beforeEach(() => {
        harness.applyDragEnd.mockReset();
        harness.showError.mockReset();
        harness.onDragEnd = undefined;
    });

    it("clears the reordering state once the save succeeds", async () => {
        render(<Harness />);

        const duringSave = await dropAndSettle((save) => save.resolve());

        expect(harness.applyDragEnd).toHaveBeenCalledOnce();
        expect(duringSave).toBe("reordering");
        expect(screen.getByTestId("reordering").textContent).toBe("idle");
        expect(harness.showError).not.toHaveBeenCalled();
    });

    it("clears the reordering state and reports the failure when the save is rejected", async () => {
        render(<Harness />);

        const duringSave = await dropAndSettle((save) => save.reject(new Error("offline")));

        expect(duringSave).toBe("reordering");
        expect(screen.getByTestId("reordering").textContent).toBe("idle");
        expect(harness.showError).toHaveBeenCalledExactlyOnceWith("Failed to move thread");
    });
});

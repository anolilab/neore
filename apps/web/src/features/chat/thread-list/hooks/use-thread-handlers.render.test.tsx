// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteBranch = vi.fn();
// The stored settings the hook reads; `undefined` is a user who has never saved them.
const settings = vi.hoisted(() => {
    return { pending: false, value: undefined as Record<string, boolean> | undefined };
});
// Every thread mutation the hook sends, in order: the confirmation tests check what reached the server.
const calls: { args: unknown; fn: string }[] = [];
// The chat the person has open; a test changes it to show a pending confirmation does not follow them.
const openChat = vi.hoisted(() => {
    return { id: "root" as string | undefined };
});
const deleteThreadMetadata = vi.fn();
const removeOptimisticDeletion = vi.fn();
const navigate = vi.fn();
const undone: string[] = [];
const successes: ReactNode[] = [];
const errors: ReactNode[] = [];
// What `deleteThreads` answers next: a count, or a refusal.
const bulk: { refuse: boolean } = { refuse: false };

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => {
            const [before, after] = (count === 1 ? forms.one : forms.other).split("#", 2);

            return `${before}${count}${after ?? ""}`;
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: (options: { fn: string }) => {
            return {
                mutateAsync: async (args: { threadId?: string; threadIds?: string[] }) => {
                    calls.push({ args, fn: options.fn });

                    if (options.fn === "undoDelete") {
                        undone.push(args.threadId!);

                        return undefined;
                    }

                    if (options.fn === "deleteThreads") {
                        if (bulk.refuse) {
                            throw new Error("FORBIDDEN");
                        }

                        return { deletedCount: args.threadIds!.length };
                    }

                    return undefined;
                },
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => navigate };
});

vi.mock("@/lib/lunora/crpc", () => {
    const mutation = (name: string) => {
        return {
            mutationOptions: () => {
                return { fn: name };
            },
        };
    };

    return {
        useCRPC: () => {
            return {
                chat: {
                    functions: {
                        deleteThreads: mutation("deleteThreads"),
                        pinThread: mutation("pin"),
                        undoDeleteThread: mutation("undoDelete"),
                        unpinThread: mutation("unpin"),
                    },
                },
            };
        },
        useLunora: () => {
            return { query: vi.fn() };
        },
        useLunoraActionOptions: () => {
            return { fn: "updateThread" };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: settings.pending ? undefined : (settings.value ?? null) };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-thread-manager", () => {
    return {
        useThreadManager: () => {
            return { createBranch: vi.fn(), deleteBranch };
        },
    };
});

vi.mock("@/features/chat/core/stores/thread-store-hooks", () => {
    return {
        useCurrentThreadId: () => openChat.id,
        useOptimisticActions: () => {
            return {
                clearOptimisticPin: vi.fn(),
                clearOptimisticStatus: vi.fn(),
                removeOptimisticDeletion,
                setOptimisticPin: vi.fn(),
                setOptimisticStatus: vi.fn(),
            };
        },
        useThreadActions: () => {
            return { deleteThreadMetadata };
        },
    };
});

vi.mock("@/features/chat/split/split-layout-store", () => {
    return { routeIsOn: () => true, survivingPaneAfterDelete: async () => undefined };
});

vi.mock("@/lib/toast", () => {
    return {
        showError: (message: ReactNode) => {
            errors.push(message);
        },
        showSuccess: (message: ReactNode) => {
            successes.push(message);
        },
    };
});

const { default: useThreadHandlers } = await import("./use-thread-handlers");

const PARTIAL_DELETE_TOAST = /Failed to delete the thread\. 1 branch was deleted\./u;

const flush = () =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

const setup = () => renderHook(() => useThreadHandlers(vi.fn(), "root")).result;

type Handlers = ReturnType<typeof useThreadHandlers>;

// Every render's handlers, so a test reads the hook as of its latest render.
const rendered = vi.fn<(handlers: Handlers) => void>();

/** Renders the hook with its confirmation dialog, so the dialog's buttons are in the document as the person sees them. */
const Confirmable = () => {
    const handlers = useThreadHandlers(vi.fn(), "root");

    rendered(handlers);

    return <>{handlers.confirmDialog}</>;
};

const current = (): Handlers => {
    const last = rendered.mock.lastCall;

    if (last === undefined) {
        throw new Error("the hook has not rendered");
    }

    return last[0];
};

describe("chat action confirmations", () => {
    beforeEach(() => {
        calls.length = 0;
        settings.value = undefined;
        settings.pending = false;
        openChat.id = "root";
        rendered.mockClear();
    });

    it("unpins at once by default, with no dialog", async () => {
        render(<Confirmable />);

        await act(async () => {
            current().handleUnpinThread("t1");
            await flush();
        });

        expect(calls).toStrictEqual([{ args: { threadId: "t1" }, fn: "unpin" }]);
        expect(screen.queryByText("Unpin this chat?")).toBeNull();
    });

    it("unpins at once when the unpin setting is saved as off", async () => {
        settings.value = { confirmBeforeUnpinChat: false };
        render(<Confirmable />);

        await act(async () => {
            current().handleUnpinThread("t1");
            await flush();
        });

        expect(calls).toStrictEqual([{ args: { threadId: "t1" }, fn: "unpin" }]);
    });

    it("asks before unpinning when the setting is on, and unpins only once confirmed", async () => {
        settings.value = { confirmBeforeUnpinChat: true };
        render(<Confirmable />);

        act(() => {
            current().handleUnpinThread("t1");
        });

        expect(screen.getByText("Unpin this chat?")).toBeTruthy();
        expect(calls).toHaveLength(0);

        fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
        await act(flush);

        expect(calls).toStrictEqual([{ args: { threadId: "t1" }, fn: "unpin" }]);
    });

    it("leaves the thread pinned when the unpin dialog is cancelled", async () => {
        settings.value = { confirmBeforeUnpinChat: true };
        render(<Confirmable />);

        act(() => {
            current().handleUnpinThread("t1");
        });

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await act(flush);

        expect(calls).toHaveLength(0);
    });

    it("asks before unpinning while the settings are still loading, so a missing answer skips no prompt", () => {
        settings.pending = true;
        render(<Confirmable />);

        act(() => {
            current().handleUnpinThread("t1");
        });

        expect(screen.getByText("Unpin this chat?")).toBeTruthy();
        expect(calls).toHaveLength(0);
    });

    it("archives at once by default, with no dialog", async () => {
        render(<Confirmable />);

        await act(async () => {
            current().updateThread("t1", "model-a", "archived");
            await flush();
        });

        expect(calls).toStrictEqual([{ args: { model: "model-a", status: "archived", threadId: "t1" }, fn: "updateThread" }]);
        expect(screen.queryByText("Archive this chat?")).toBeNull();
    });

    it("archives at once when the archive setting is saved as off", async () => {
        settings.value = { confirmBeforeArchiveChat: false };
        render(<Confirmable />);

        await act(async () => {
            current().updateThread("t1", "model-a", "archived");
            await flush();
        });

        expect(calls).toStrictEqual([{ args: { model: "model-a", status: "archived", threadId: "t1" }, fn: "updateThread" }]);
    });

    it("asks before archiving when the setting is on, and archives only once confirmed", async () => {
        settings.value = { confirmBeforeArchiveChat: true };
        render(<Confirmable />);

        act(() => {
            current().updateThread("t1", "model-a", "archived");
        });

        expect(screen.getByText("Archive this chat?")).toBeTruthy();
        expect(calls).toHaveLength(0);

        fireEvent.click(screen.getByRole("button", { name: "Archive" }));
        await act(flush);

        expect(calls).toStrictEqual([{ args: { model: "model-a", status: "archived", threadId: "t1" }, fn: "updateThread" }]);
    });

    it("moves focus to the search toggle after a confirmed archive from the sidebar, since the archived row is leaving", async () => {
        settings.value = { confirmBeforeArchiveChat: true };
        render(
            <>
                <div data-slot="sidebar">
                    <button type="button">Archive row</button>
                    <button data-search-toggle="" type="button">
                        Search threads
                    </button>
                </div>
                <Confirmable />
            </>,
        );

        screen.getByRole("button", { name: "Archive row" }).focus();
        act(() => {
            current().updateThread("t1", "model-a", "archived");
        });
        fireEvent.click(screen.getByRole("button", { name: "Archive" }));

        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search threads" })));
    });

    it("leaves focus where it was after a confirmed archive asked from outside the sidebar, such as the shortcut or the palette", async () => {
        settings.value = { confirmBeforeArchiveChat: true };
        render(
            <>
                <div data-slot="sidebar">
                    <button data-search-toggle="" type="button">
                        Search threads
                    </button>
                </div>
                <button type="button">Chat composer</button>
                <Confirmable />
            </>,
        );

        screen.getByRole("button", { name: "Chat composer" }).focus();
        act(() => {
            current().updateThread("t1", "model-a", "archived");
        });
        fireEvent.click(screen.getByRole("button", { name: "Archive" }));
        await act(flush);

        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts
        expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Search threads" }));
    });

    it("moves focus to the search toggle after a confirmed unpin from the sidebar, since the pinned row leaves its group", async () => {
        settings.value = { confirmBeforeUnpinChat: true };
        render(
            <>
                <div data-slot="sidebar">
                    <button type="button">Unpin row</button>
                    <button data-search-toggle="" type="button">
                        Search threads
                    </button>
                </div>
                <Confirmable />
            </>,
        );

        screen.getByRole("button", { name: "Unpin row" }).focus();
        act(() => {
            current().handleUnpinThread("t1");
        });
        fireEvent.click(screen.getByRole("button", { name: "Unpin" }));

        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search threads" })));
    });

    it("restores without asking even when the archive setting is on", async () => {
        settings.value = { confirmBeforeArchiveChat: true };
        render(<Confirmable />);

        await act(async () => {
            current().updateThread("t1", "model-a", "active");
            await flush();
        });

        expect(calls).toStrictEqual([{ args: { model: "model-a", status: "active", threadId: "t1" }, fn: "updateThread" }]);
        expect(screen.queryByText("Archive this chat?")).toBeNull();
    });

    it("calls the caller's onCancel when the archive confirmation is backed out of, and runs nothing", async () => {
        settings.value = { confirmBeforeArchiveChat: true };
        const onCancel = vi.fn();

        render(<Confirmable />);

        act(() => {
            current().updateThread("t1", "model-a", "archived", { onCancel });
        });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await act(flush);

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(0);
    });

    it("calls the caller's onCancel when the unpin confirmation is backed out of", async () => {
        settings.value = { confirmBeforeUnpinChat: true };
        const onCancel = vi.fn();

        render(<Confirmable />);

        act(() => {
            current().handleUnpinThread("t1", { onCancel });
        });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await act(flush);

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(0);
    });

    it("does not call onCancel once the archive is confirmed", async () => {
        settings.value = { confirmBeforeArchiveChat: true };
        const onCancel = vi.fn();

        render(<Confirmable />);

        act(() => {
            current().updateThread("t1", "model-a", "archived", { onCancel });
        });
        fireEvent.click(screen.getByRole("button", { name: "Archive" }));
        await act(flush);

        expect(calls).toHaveLength(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it("drops a pending archive once another chat is open, so confirming it does nothing", async () => {
        settings.value = { confirmBeforeArchiveChat: true };
        const view = render(<Confirmable />);

        act(() => {
            current().updateThread("t1", "model-a", "archived");
        });
        expect(screen.getByText("Archive this chat?")).toBeTruthy();

        openChat.id = "other";
        view.rerender(<Confirmable />);

        expect(screen.queryByText("Archive this chat?")).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it("exposes delete as confirmed by default, for its callers to ask about", () => {
        render(<Confirmable />);

        expect(current().confirmBeforeDelete).toBe(true);
    });

    it("exposes delete as not confirmed once the setting is saved as off", () => {
        settings.value = { confirmBeforeDeleteChat: false };
        render(<Confirmable />);

        expect(current().confirmBeforeDelete).toBe(false);
    });
});

describe("useThreadHandlers deletes", () => {
    beforeEach(() => {
        deleteBranch.mockReset();
        deleteThreadMetadata.mockClear();
        removeOptimisticDeletion.mockClear();
        navigate.mockClear();
        undone.length = 0;
        successes.length = 0;
        errors.length = 0;
        bulk.refuse = false;
    });

    it("reports a refused delete without a success toast", async () => {
        expect.assertions(2);

        deleteBranch.mockResolvedValue({ deletedIds: [], threadDeleted: false });

        const handlers = setup();

        await act(async () => {
            handlers.current.handleDeleteThread("root");
            await flush();
        });

        expect(successes).toHaveLength(0);
        expect(errors).toStrictEqual(["Failed to delete threads"]);
    });

    it("still offers Undo for the branches deleted when the thread was refused", async () => {
        expect.assertions(3);

        deleteBranch.mockResolvedValue({ deletedIds: ["child"], threadDeleted: false });

        const handlers = setup();

        await act(async () => {
            handlers.current.handleDeleteThread("root");
            await flush();
        });

        expect(successes).toHaveLength(0);

        render(<>{errors[0]}</>);

        expect(screen.getByText(PARTIAL_DELETE_TOAST)).toBeDefined();

        fireEvent.click(screen.getByRole("button", { name: "Undo" }));
        await act(flush);

        expect(undone).toStrictEqual(["child"]);
    });

    it("keeps metadata, shows no success and stays put when a bulk delete is refused", async () => {
        expect.assertions(4);

        bulk.refuse = true;

        const handlers = setup();

        await act(async () => {
            await handlers.current.handleBulkDeleteThreads(["root", "other"]);
            await flush();
        });

        expect(deleteThreadMetadata).not.toHaveBeenCalled();
        expect(successes).toHaveLength(0);
        expect(errors).toStrictEqual(["Failed to delete threads"]);
        expect(navigate).not.toHaveBeenCalled();
    });
});

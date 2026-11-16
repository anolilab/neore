// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteBranch = vi.fn();
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

vi.mock("@/features/chat/core/hooks/use-thread-manager", () => {
    return {
        useThreadManager: () => {
            return { createBranch: vi.fn(), deleteBranch };
        },
    };
});

vi.mock("@/features/chat/core/stores/thread-store-hooks", () => {
    return {
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

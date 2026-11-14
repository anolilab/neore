// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadMetadata } from "../stores/thread-store";

// Threads the server refuses to delete (an admin acting as the owner is refused).
const refused = new Set<string>();
const navigate = vi.fn();

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: (options: { fn: string }) => {
            return {
                mutateAsync: async (args: { threadId: string }) => {
                    if (options.fn === "softDelete" && refused.has(args.threadId)) {
                        throw new Error("FORBIDDEN");
                    }

                    return args.threadId;
                },
            };
        },
        useQueryClient: () => {
            return { setQueryData: vi.fn() };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { useNavigate: () => navigate };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    functions: {
                        branchThread: {
                            mutationOptions: () => {
                                return { fn: "branch" };
                            },
                        },
                        softDeleteThread: {
                            mutationOptions: () => {
                                return { fn: "softDelete" };
                            },
                        },
                    },
                },
            };
        },
        useLunora: () => {
            return { query: vi.fn() };
        },
    };
});

vi.mock("@/features/chat/split/split-layout-store", () => {
    return {
        routeIsOn: () => true,
        survivingPaneAfterDelete: async () => undefined,
    };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

vi.mock("@/lib/logger", () => {
    return { providerLogger: { error: vi.fn() } };
});

vi.mock("./use-all-threads-data", () => {
    return {
        default: () => {
            return {
                hasMore: false,
                lunora: [
                    { _creationTime: 1, _id: "root", parentThreadIds: [] },
                    { _creationTime: 2, _id: "child", parentThreadIds: ["root"] },
                ],
            };
        },
    };
});

const { default: useThreadStore } = await import("../stores/thread-store");
const { useThreadManager } = await import("./use-thread-manager");

const metadata = (title: string, parentThreadId?: string): ThreadMetadata => {
    return { createdAt: new Date(0), lastActivity: new Date(0), parentThreadId, status: "active", title };
};

const flush = () =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

describe("useThreadManager deleteBranch", () => {
    beforeEach(() => {
        refused.clear();
        navigate.mockClear();
        useThreadStore.setState({
            optimisticDeletions: new Set(),
            threadMetadata: new Map([
                ["child", metadata("Child", "root")],
                ["root", metadata("Root")],
            ]),
        });
    });

    it("brings a refused thread back, keeps its metadata and stays on it", async () => {
        expect.assertions(4);

        refused.add("root");
        refused.add("child");

        const { result } = renderHook(() => useThreadManager(true, "root"));
        let outcome: Awaited<ReturnType<typeof result.current.deleteBranch>> | undefined;

        await act(async () => {
            outcome = await result.current.deleteBranch("root");
        });
        await flush();

        expect(outcome).toStrictEqual({ deletedIds: [], threadDeleted: false });
        expect(useThreadStore.getState().optimisticDeletions.size).toBe(0);
        expect([...useThreadStore.getState().threadMetadata.keys()]).toStrictEqual(["child", "root"]);
        expect(navigate).not.toHaveBeenCalled();
    });

    it("reports the branches deleted when only the thread is refused", async () => {
        expect.assertions(3);

        refused.add("root");

        const { result } = renderHook(() => useThreadManager(true, "root"));
        let outcome: Awaited<ReturnType<typeof result.current.deleteBranch>> | undefined;

        await act(async () => {
            outcome = await result.current.deleteBranch("root");
        });

        expect(outcome).toStrictEqual({ deletedIds: ["child"], threadDeleted: false });
        expect([...useThreadStore.getState().optimisticDeletions]).toStrictEqual(["child"]);
        expect([...useThreadStore.getState().threadMetadata.keys()]).toStrictEqual(["root"]);
    });

    it("lists the thread first when it and its branches are deleted, and leaves it", async () => {
        expect.assertions(2);

        const { result } = renderHook(() => useThreadManager(true, "root"));
        let outcome: Awaited<ReturnType<typeof result.current.deleteBranch>> | undefined;

        await act(async () => {
            outcome = await result.current.deleteBranch("root");
        });
        await flush();

        expect(outcome).toStrictEqual({ deletedIds: ["root", "child"], threadDeleted: true });
        expect(navigate).toHaveBeenCalledWith({ replace: true, to: "/chat" });
    });
});

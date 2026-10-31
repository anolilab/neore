import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return { removeQueries: vi.fn(), userId: "user-a" as string | undefined };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: vi.fn(() => {
            return {};
        }),
        useQuery: vi.fn(() => {
            return { data: { limit: 20, watched: [{ repository: "a/private" }] } };
        }),
        useQueryClient: () => {
            return { removeQueries: state.removeQueries };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: () => vi.fn(),
        useCRPC: () => {
            return {
                source_control: {
                    freshness: {
                        listWatchedRepositories: {
                            queryOptions: () => {
                                return { queryKey: ["watched"] };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("./use-develop", () => {
    return { useDevelopUser: () => state.userId };
});

const { useWatchedRepositories } = await import("./use-watched");

describe("useWatchedRepositories", () => {
    beforeEach(() => {
        state.removeQueries.mockClear();
        state.userId = "user-a";
    });

    it("never shows the previous account's list after the account changes", () => {
        const { rerender, result } = renderHook(() => useWatchedRepositories(true));

        expect(result.current.data?.watched).toHaveLength(1);

        state.userId = "user-b";
        rerender();

        expect(result.current.data).toBeUndefined();
        expect(state.removeQueries).toHaveBeenCalledWith({ queryKey: ["watched"] });
    });
});

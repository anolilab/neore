import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return {
        client: {} as Record<string, unknown>,
        // What the cache holds after a read: the pull request's head and each query's status.
        data: undefined as unknown,
        invalidateQueries: vi.fn(),
        status: undefined as string | undefined,
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skip"),
        useMutation: vi.fn(),
        useQuery: vi.fn(),
        useQueryClient: () => state.client,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: () => vi.fn(),
        useCRPC: () => {
            return {};
        },
    };
});

vi.mock("./use-develop", () => {
    return { DEVELOP_QUERY_ROOT: "develop", useDevelopUser: () => "user-a" };
});

const { useRefreshPullForOtherGuideHead } = await import("./use-guide");

const address = { number: 1, repository: "a/b" };

describe("useRefreshPullForOtherGuideHead", () => {
    beforeEach(() => {
        state.invalidateQueries = vi.fn(async () => {});
        state.data = { detail: { headSha: "newer" }, status: "ok" };
        state.status = "success";
        // A new client per test, as in a new session: the record of refreshed heads belongs to it.
        state.client = {
            getQueryData: () => state.data,
            getQueryState: () => {
                return { status: state.status };
            },
            invalidateQueries: state.invalidateQueries,
        };
    });

    const settle = async () => {
        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
        });
    };

    it("reads the pull request again once per guide head that is not the page's", () => {
        const { rerender } = renderHook(({ guide }: { guide: string | undefined }) => useRefreshPullForOtherGuideHead(address, guide, "page"), {
            initialProps: { guide: "newer" as string | undefined },
        });

        rerender({ guide: "newer" });

        expect(state.invalidateQueries).toHaveBeenCalledTimes(3);
        expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["develop", "user-a", "pull", address] });

        rerender({ guide: "other" });

        expect(state.invalidateQueries).toHaveBeenCalledTimes(6);
    });

    it("reads the files and commits again with the pull request, so the diff shown is the head acted on", () => {
        renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

        expect(state.invalidateQueries.mock.calls.map(([options]) => (options as { queryKey: string[] }).queryKey[2])).toStrictEqual([
            "pull",
            "files",
            "commits",
        ]);
    });

    it("refreshes another pull request that has the same guide head", () => {
        const other = { number: 2, repository: "a/b" };
        const { rerender } = renderHook(({ at }: { at: typeof address }) => useRefreshPullForOtherGuideHead(at, "newer", "page"), {
            initialProps: { at: address },
        });

        rerender({ at: other });

        expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["develop", "user-a", "pull", other] });
        expect(state.invalidateQueries).toHaveBeenCalledTimes(6);
    });

    it("does not read the pull request again when the tab is left and opened on the same stale guide", async () => {
        const { unmount } = renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

        expect(state.invalidateQueries).toHaveBeenCalledTimes(3);

        await settle();
        unmount();
        renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

        expect(state.invalidateQueries).toHaveBeenCalledTimes(3);

        // A new head still refreshes.
        renderHook(() => useRefreshPullForOtherGuideHead(address, "newest", "page"));

        expect(state.invalidateQueries).toHaveBeenCalledTimes(6);
    });

    it("tries again on a later visit when the read failed", async () => {
        state.status = "error";

        const view = renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

        await settle();
        view.unmount();
        renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

        expect(state.invalidateQueries).toHaveBeenCalledTimes(6);
    });

    it("tries again when the pull request's head is still unknown after the read", async () => {
        state.data = undefined;

        const view = renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

        await settle();
        view.unmount();
        renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

        expect(state.invalidateQueries).toHaveBeenCalledTimes(6);
    });

    it("stops after three failed attempts", async () => {
        state.status = "error";

        for (let visit = 0; visit < 5; visit += 1) {
            const { unmount } = renderHook(() => useRefreshPullForOtherGuideHead(address, "newer", "page"));

            await settle();
            unmount();
        }

        expect(state.invalidateQueries).toHaveBeenCalledTimes(9);
    });

    it("does not start a second read while one is running", () => {
        const { rerender } = renderHook(({ page }: { page: string }) => useRefreshPullForOtherGuideHead(address, "newer", page), {
            initialProps: { page: "page" },
        });

        rerender({ page: "page2" });

        expect(state.invalidateQueries).toHaveBeenCalledTimes(3);
    });

    it("does nothing for a guide of the page's head or no guide", () => {
        renderHook(() => useRefreshPullForOtherGuideHead(address, "page", "page"));
        renderHook(() => useRefreshPullForOtherGuideHead(address, undefined, "page"));

        expect(state.invalidateQueries).not.toHaveBeenCalled();
    });
});

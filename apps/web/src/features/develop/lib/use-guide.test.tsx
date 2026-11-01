import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return { invalidateQueries: vi.fn() };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skip"),
        useMutation: vi.fn(),
        useQuery: vi.fn(),
        useQueryClient: () => {
            return { invalidateQueries: state.invalidateQueries };
        },
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
        state.invalidateQueries.mockClear();
    });

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

    it("does nothing for a guide of the page's head or no guide", () => {
        renderHook(() => useRefreshPullForOtherGuideHead(address, "page", "page"));
        renderHook(() => useRefreshPullForOtherGuideHead(address, undefined, "page"));

        expect(state.invalidateQueries).not.toHaveBeenCalled();
    });
});

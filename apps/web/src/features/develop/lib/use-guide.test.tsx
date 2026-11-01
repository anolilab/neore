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

        expect(state.invalidateQueries).toHaveBeenCalledTimes(1);
        expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["develop", "user-a", "pull", address] });

        rerender({ guide: "other" });

        expect(state.invalidateQueries).toHaveBeenCalledTimes(2);
    });

    it("does nothing for a guide of the page's head or no guide", () => {
        renderHook(() => useRefreshPullForOtherGuideHead(address, "page", "page"));
        renderHook(() => useRefreshPullForOtherGuideHead(address, undefined, "page"));

        expect(state.invalidateQueries).not.toHaveBeenCalled();
    });
});

/**
 * `useAdminFeedback()`: the list is not live, so an open page reads again on its own, bringing in feedback sent since
 * and fresh signed image URLs.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return { reads: 0 };
});

vi.mock("@/lib/lunora/crpc", () => {
    const listFeedback = {
        queryOptions: (args: unknown) => {
            return {
                queryFn: async () => {
                    harness.reads += 1;

                    return { continueCursor: null, isDone: true, page: [] };
                },
                queryKey: ["lunora", "feedback_admin:listFeedback", args],
            };
        },
    };

    return {
        useAction: () => vi.fn(),
        useCRPC: () => {
            return { feedback: { admin: { listFeedback } } };
        },
        useLunoraActionOptions: () => {
            return {};
        },
    };
});

const { ADMIN_FEEDBACK_REFETCH_INTERVAL_MS, useAdminFeedback } = await import("./use-admin");

describe(useAdminFeedback, () => {
    beforeEach(() => {
        harness.reads = 0;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reads the page again while it stays open", async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
        const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

        const { unmount } = renderHook(() => useAdminFeedback({ cursor: null, limit: 20 }), { wrapper });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(harness.reads).toBe(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(ADMIN_FEEDBACK_REFETCH_INTERVAL_MS);
        });

        expect(harness.reads).toBe(2);

        unmount();
        queryClient.clear();
    });
});

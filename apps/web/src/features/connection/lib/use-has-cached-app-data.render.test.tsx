// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import useHasCachedAppData from "./use-has-cached-app-data";

vi.mock("@lunora/react", () => {
    return {
        useAuthState: () => {
            return { isAuthenticated: true, isLoading: false };
        },
    };
});
const account = vi.hoisted(() => {
    return { userId: "user-a" as string | undefined };
});

vi.mock("@/features/chat/thread-list/hooks/use-thread-list-cache", () => {
    return { useCacheUserId: () => account.userId, useThreadListPlaceholder: () => undefined };
});

const THREAD_LIST = ["lunora", "chat_composite:getThreadListData", {}];

const renderWithClient = (queryClient: QueryClient) =>
    renderHook(() => useHasCachedAppData(), {
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });

describe(useHasCachedAppData, () => {
    beforeEach(() => {
        account.userId = "user-a";
    });

    it("turns true once the thread list lands in the cache", () => {
        const queryClient = new QueryClient();
        const { result } = renderWithClient(queryClient);

        expect(result.current).toBe(false);

        act(() => {
            queryClient.setQueryData(THREAD_LIST, { threads: [] });
        });

        expect(result.current).toBe(true);
    });

    it("does not rescan the cache for a push to another query", () => {
        const queryClient = new QueryClient();

        renderWithClient(queryClient);

        const scan = vi.spyOn(queryClient, "getQueriesData");

        act(() => {
            queryClient.setQueryData(["lunora", "chat_functions:getThread", { threadId: "t" }], { title: "a" });
            queryClient.setQueryData(["lunora", "chat_functions:getThread", { threadId: "t" }], { title: "b" });
        });

        expect(scan).not.toHaveBeenCalled();
    });

    it("does not count the previous account's cached list after a switch, until the query delivers again", () => {
        const queryClient = new QueryClient();

        queryClient.setQueryData(THREAD_LIST, { threads: ["a's thread"] });

        const { rerender, result } = renderWithClient(queryClient);

        expect(result.current).toBe(true);

        account.userId = "user-b";
        rerender();

        expect(result.current).toBe(false);

        act(() => {
            // Equal data, as a refetch with structural sharing keeps the same reference; it was still delivered for this account.
            queryClient.setQueryData(THREAD_LIST, queryClient.getQueryData(THREAD_LIST), { updatedAt: Date.now() + 1 });
        });

        expect(result.current).toBe(true);
    });

    it("counts a list cached before the first token lands", () => {
        account.userId = undefined;
        const queryClient = new QueryClient();

        queryClient.setQueryData(THREAD_LIST, { threads: [] });

        const { rerender, result } = renderWithClient(queryClient);

        account.userId = "user-a";
        rerender();

        expect(result.current).toBe(true);
    });
});

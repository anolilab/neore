// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import useHasCachedAppData from "./use-has-cached-app-data";

vi.mock("@lunora/react", () => {
    return {
        useAuthState: () => {
            return { isAuthenticated: true, isLoading: false };
        },
    };
});
vi.mock("@/features/chat/thread-list/hooks/use-thread-list-cache", () => {
    return { useThreadListPlaceholder: () => undefined };
});

const THREAD_LIST = ["lunora", "chat_composite:getThreadListData", {}];

const renderWithClient = (queryClient: QueryClient) =>
    renderHook(() => useHasCachedAppData(), {
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });

describe(useHasCachedAppData, () => {
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

        // The cache the hook scans with `findAll`; spied after mount, so only a rescan for a push would count.
        const scan = vi.spyOn(queryClient.getQueryCache(), "findAll");

        act(() => {
            queryClient.setQueryData(["lunora", "chat_functions:getThread", { threadId: "t" }], { title: "a" });
            queryClient.setQueryData(["lunora", "chat_functions:getThread", { threadId: "t" }], { title: "b" });
        });

        expect(scan).not.toHaveBeenCalled();
    });

    it("turns false when the list is removed, and true again when it lands", () => {
        const queryClient = new QueryClient();

        queryClient.setQueryData(THREAD_LIST, { threads: ["a's thread"] });

        const { result } = renderWithClient(queryClient);

        expect(result.current).toBe(true);

        act(() => {
            // What the live-query manager does as another account's token lands.
            queryClient.removeQueries({ queryKey: THREAD_LIST });
        });

        expect(result.current).toBe(false);

        act(() => {
            queryClient.setQueryData(THREAD_LIST, { threads: ["b's thread"] });
        });

        expect(result.current).toBe(true);
    });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { isPreHostRefusal, usePullRequestActions } from "./use-pull-request-actions";

const { action } = vi.hoisted(() => {
    return { action: vi.fn() };
});

vi.mock("@neore/backend/api", () => {
    return { api: { source_control: { pull_request_actions: { editPullRequest: "edit", requestReviewers: "reviewers", revertPullRequest: "revert" } } } };
});
vi.mock("@/lib/lunora/crpc", () => {
    return { useAction: () => action };
});
vi.mock("./use-develop", () => {
    return { DEVELOP_QUERY_ROOT: "develop", useDevelopUser: () => "user" };
});

describe("isPreHostRefusal", () => {
    it.each(["BAD_REQUEST", "FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED", "VALIDATION_ERROR"])("treats %s as thrown before any host call", (code) => {
        expect(isPreHostRefusal({ code })).toBe(true);
    });

    it("reads the code under data, where the client puts a server error's code", () => {
        expect(isPreHostRefusal({ data: { code: "TOO_MANY_REQUESTS" } })).toBe(true);
        expect(isPreHostRefusal({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    });

    it("does not treat a server failure as a refusal: the host may have acted before it failed", () => {
        expect(isPreHostRefusal({ code: "INTERNAL_SERVER_ERROR" })).toBe(false);
    });

    it("does not treat an error without a code as a refusal", () => {
        expect(isPreHostRefusal(new Error("connection lost"))).toBe(false);
        expect(isPreHostRefusal(undefined)).toBe(false);
    });
});

describe("usePullRequestActions", () => {
    it("never retries a write that failed: a second send could act twice on the host", async () => {
        action.mockReset();
        action.mockRejectedValue(new Error("connection lost"));

        // The client retries mutations by default here, so only an explicit `retry: 0` on the writes keeps them to one send.
        const client = new QueryClient({ defaultOptions: { mutations: { retry: 3, retryDelay: 0 } } });
        const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
        const { result } = renderHook(() => usePullRequestActions({ number: 7, repository: "octo/hello" } as never), { wrapper });

        await expect(result.current.revert.mutateAsync()).rejects.toThrow("connection lost");
        await expect(result.current.requestReviewers.mutateAsync(["octocat"])).rejects.toThrow("connection lost");

        expect(action).toHaveBeenCalledTimes(2);
    });
});

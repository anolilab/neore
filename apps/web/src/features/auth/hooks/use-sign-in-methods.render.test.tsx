/**
 * `inviteOnly` from `GET /api/auth/sign-in-methods`: unknown until the answer,
 * and invite-only when the backend fails or does not say.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import useSignInMethods, { SIGN_IN_METHODS_STALE_MS } from "./use-sign-in-methods";

const wrapperFor =
    (client: QueryClient) =>
    ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const wrapper = ({ children }: { children: ReactNode }) => wrapperFor(new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } }))({ children });

const answer = (response: () => Promise<Response>) => {
    vi.stubGlobal("fetch", vi.fn(response));
};

describe("useSignInMethods().inviteOnly", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("is unknown until the backend answers", () => {
        answer(
            () =>
                new Promise<Response>(() => {
                    // Never answers.
                }),
        );

        const { result } = renderHook(() => useSignInMethods(), { wrapper });

        expect(result.current.inviteOnly).toBeUndefined();
    });

    it.each([true, false])("follows the backend's %o", async (inviteOnly) => {
        answer(async () => Response.json({ inviteOnly, oidc: null, passkey: true, social: [] }));

        const { result } = renderHook(() => useSignInMethods(), { wrapper });

        await waitFor(() => {
            expect(result.current.inviteOnly).toBe(inviteOnly);
        });
    });

    it("reads a backend that does not say as invite-only", async () => {
        answer(async () => Response.json({ oidc: null, passkey: true, social: [] }));

        const { result } = renderHook(() => useSignInMethods(), { wrapper });

        await waitFor(() => {
            expect(result.current.inviteOnly).toBe(true);
        });
    });

    it("reads a failed request as invite-only", async () => {
        answer(async () => new Response("down", { status: 503 }));

        const { result } = renderHook(() => useSignInMethods(), { wrapper });

        await waitFor(() => {
            expect(result.current.inviteOnly).toBe(true);
        });
    });

    it("reads the policy again once its answer is five minutes old", async () => {
        let inviteOnly = true;

        answer(async () => Response.json({ inviteOnly, oidc: null, passkey: true, social: [] }));

        const client = new QueryClient();
        const { result: firstResult, unmount } = renderHook(() => useSignInMethods(), { wrapper: wrapperFor(client) });

        await waitFor(() => {
            expect(firstResult.current.inviteOnly).toBe(true);
        });
        unmount();

        // The operator opens registration; a later mount past the stale time sees it.
        inviteOnly = false;
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + SIGN_IN_METHODS_STALE_MS + 1000);

        const { result: secondResult } = renderHook(() => useSignInMethods(), { wrapper: wrapperFor(client) });

        await waitFor(() => {
            expect(secondResult.current.inviteOnly).toBe(false);
        });
    });
});

/**
 * `inviteOnly` from `GET /api/auth/sign-in-methods`: unknown until the answer,
 * and invite-only when the backend fails or does not say.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import useSignInMethods from "./use-sign-in-methods";

const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })}>{children}</QueryClientProvider>
);

const answer = (response: () => Promise<Response>) => {
    vi.stubGlobal("fetch", vi.fn(response));
};

describe("useSignInMethods().inviteOnly", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
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
});

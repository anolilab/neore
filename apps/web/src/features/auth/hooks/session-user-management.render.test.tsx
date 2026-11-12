/**
 * `useSession` under hydration: the server never has the `["session"]` query, while the browser may have it by the
 * time a late Suspense boundary (a lazily loaded route) hydrates. The hydration render must draw what the server drew.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AuthClient } from "@/lib/auth/client";

import { AuthQueryProvider } from "../lib/auth-query-provider";
import { useSession } from "./session-user-management";

const SESSION = {
    session: { createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z", id: "s1", updatedAt: "2026-01-01T00:00:00.000Z" },
    user: { createdAt: "2026-01-01T00:00:00.000Z", id: "u1", name: "Ada", updatedAt: "2026-01-01T00:00:00.000Z" },
};

const authClient = { getSession: vi.fn(async () => SESSION) } as unknown as AuthClient;

const Username = () => {
    const { user } = useSession(authClient);

    return <span>{user?.name ?? "nobody"}</span>;
};

const app = (queryClient: QueryClient) => (
    <QueryClientProvider client={queryClient}>
        <AuthQueryProvider>
            <Username />
        </AuthQueryProvider>
    </QueryClientProvider>
);

describe("useSession while hydrating", () => {
    it("draws the server's empty state in the hydration render, then the user", async () => {
        const view = renderToString(app(new QueryClient()));

        expect(view).toContain("nobody");

        // The browser already holds the session when this subtree hydrates.
        const browserClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });

        browserClient.setQueryData(["session"], SESSION);

        const host = document.createElement("div");
        const recoverable = vi.fn();

        host.innerHTML = view;
        document.body.appendChild(host);

        const root = await act(async () => hydrateRoot(host, app(browserClient), { onRecoverableError: recoverable }));

        expect(recoverable).not.toHaveBeenCalled();
        expect(host.textContent).toBe("Ada");

        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

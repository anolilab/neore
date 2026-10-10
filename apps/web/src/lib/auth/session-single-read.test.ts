/**
 * One page load reads the session ONCE.
 *
 * Three readers used to make their own `GET …/get-session` on every full page
 * load: better-auth's session atom (`authClient.useSession`), the TanStack
 * `["session"]` query (`features/auth/hooks/session-user-management.ts`) and
 * Lunora's identity probe (`LunoraClient.getCurrentUser`, straight to the
 * backend origin). This drives the REAL modules — `lib/auth/client.ts` and the
 * probe fetch `router.tsx` hands `LunoraClient` — against a fake auth server
 * and counts the reads.
 */
import { LunoraClient } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../env"), () => {
    return {
        default: {
            VITE_LLM_GATEWAY_URL: "http://localhost:8787",
            VITE_LUNORA_URL: "http://localhost:8788",
            VITE_SITE_URL: "http://localhost:3000",
        } as never,
    };
});

const BACKEND = "http://localhost:8788";

interface FakeUser {
    email: string;
    id: string;
    name: string;
}

const ADA: FakeUser = { email: "ada@example.com", id: "user_ada", name: "Ada" };

/** A better-auth server reduced to what these flows touch. */
const createFakeAuthServer = (initialUser: FakeUser | null) => {
    let user = initialUser;
    const sessionReads: string[] = [];

    const sessionBody = () =>
        user
            ? {
                  session: {
                      createdAt: "2026-10-01T00:00:00.000Z",
                      expiresAt: "2026-11-01T00:00:00.000Z",
                      id: `session_${user.id}`,
                      token: "t",
                      updatedAt: "2026-10-01T00:00:00.000Z",
                      userId: user.id,
                  },
                  user: { ...user, createdAt: "2026-10-01T00:00:00.000Z", emailVerified: true, updatedAt: "2026-10-01T00:00:00.000Z" },
              }
            : null;

    const fetchImpl = vi.fn(async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const { pathname } = new URL(request.url);

        if (pathname.endsWith("/get-session") && request.method === "GET") {
            sessionReads.push(request.url);

            return Response.json(sessionBody());
        }

        if (pathname.endsWith("/sign-in/email")) {
            user = ADA;

            return Response.json({ redirect: false, token: "t", user: sessionBody()?.user });
        }

        if (pathname.endsWith("/sign-out")) {
            user = null;

            return Response.json({ success: true });
        }

        if (pathname.endsWith("/organization/set-active")) {
            return Response.json({ id: "org_1" });
        }

        throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    return {
        fetchImpl,
        /** Another tab (or anything else this one did not see) changed the session. */
        setUser: (next: FakeUser | null) => {
            user = next;
        },
        get sessionReads() {
            return sessionReads;
        },
    };
};

/** Drain timers and promise chains (better-auth mounts its fetch on a `setTimeout(0)`). */
const settle = async () => {
    for (let index = 0; index < 10; index += 1) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

/** A fresh module graph per test: the shared read is a module-level singleton. */
const bootApp = async () => {
    vi.resetModules();

    const { authClient } = await import("./client");
    const { createIdentityProbeFetch } = await import("./shared-session");

    // As `router.tsx` builds it.
    const lunora = new LunoraClient({ fetch: createIdentityProbeFetch(async (input, init) => await fetch(input, init)), url: BACKEND });
    const identity = getIdentityStore(lunora);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // `useSession` (session-user-management.ts): the TanStack `["session"]` query.
    const readSessionQuery = async () =>
        await queryClient.fetchQuery({
            queryFn: async () => await authClient.getSession({ fetchOptions: { throw: true } }),
            queryKey: ["session"],
            staleTime: 0,
        });
    const atom = authClient.$store.atoms.session as unknown as {
        get: () => { data: { user: { id: string } } | null; error: unknown; isPending: boolean };
        subscribe: (listener: () => void) => () => void;
    };

    return { atom, authClient, identity, lunora, queryClient, readSessionQuery };
};

const userIdOf = (value: unknown): string | null => (value as { user?: { id?: string } } | null)?.user?.id ?? null;

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("one session read per page load", () => {
    it("a signed-in first page load reads the session ONCE, and every reader sees the user", async () => {
        const server = createFakeAuthServer(ADA);

        vi.stubGlobal("fetch", server.fetchImpl);

        const { atom, identity, lunora, readSessionQuery } = await bootApp();

        // Hydration: the SSR token is seeded (`seedHydratedAuthToken`), `<Authenticated>`
        // subscribes to Lunora's identity, `AuthRecovery` mounts `authClient.useSession()`.
        lunora.setAuthToken("jwt-ada");

        const unsubscribeIdentity = identity.subscribe(() => undefined);
        const unsubscribeAtom = atom.subscribe(() => undefined);

        await settle();

        expect(identity.getStatus()).toBe("authenticated");
        expect(identity.getUser()).toMatchObject({ id: ADA.id });
        expect(atom.get().data?.user.id).toBe(ADA.id);

        // The gate opened, the dashboard shell mounted: its `useSession` query runs LATER.
        expect(userIdOf(await readSessionQuery())).toBe(ADA.id);

        expect(server.sessionReads).toHaveLength(1);
        // Through the app's own auth proxy, not straight to the backend origin.
        expect(server.sessionReads[0]).toBe(`${globalThis.location.origin}/api/auth/get-session`);

        unsubscribeIdentity();
        unsubscribeAtom();
    });

    it("sign-in re-reads once and every reader sees the new user; sign-out clears all three", async () => {
        const server = createFakeAuthServer(null);

        vi.stubGlobal("fetch", server.fetchImpl);

        const { atom, authClient, identity, lunora, queryClient, readSessionQuery } = await bootApp();
        const unsubscribeIdentity = identity.subscribe(() => undefined);
        const unsubscribeAtom = atom.subscribe(() => undefined);

        await settle();

        expect(identity.getStatus()).toBe("unauthenticated");
        expect(atom.get().data).toBeNull();
        expect(await readSessionQuery()).toBeNull();
        expect(server.sessionReads).toHaveLength(1);

        // Sign in. better-auth re-reads the session on success ($sessionSignal);
        // the cached "nobody" must not answer it.
        await authClient.signIn.email({ email: ADA.email, password: "pw" });
        await settle();

        expect(atom.get().data?.user.id).toBe(ADA.id);
        expect(server.sessionReads).toHaveLength(2);

        // `AuthRecovery` adopts the new RPC token, so Lunora re-probes; the
        // `onSessionChange` handler refetches `["session"]`. Both join that one re-read.
        lunora.setAuthToken("jwt-ada");
        await settle();
        await queryClient.refetchQueries({ queryKey: ["session"] });

        expect(identity.getUser()).toMatchObject({ id: ADA.id });
        expect(userIdOf(queryClient.getQueryData(["session"]))).toBe(ADA.id);
        expect(server.sessionReads).toHaveLength(2);

        // Sign out: the cached session must not survive it anywhere.
        await authClient.signOut();
        await settle();
        lunora.setAuthToken(null);
        await settle();
        await queryClient.refetchQueries({ queryKey: ["session"] });

        expect(atom.get().data).toBeNull();
        expect(identity.getStatus()).toBe("unauthenticated");
        expect(queryClient.getQueryData(["session"])).toBeNull();
        expect(server.sessionReads).toHaveLength(3);

        unsubscribeIdentity();
        unsubscribeAtom();
    });

    it("an organization switch (any session-changing POST) drops the shared read", async () => {
        const server = createFakeAuthServer(ADA);

        vi.stubGlobal("fetch", server.fetchImpl);

        const { authClient, readSessionQuery } = await bootApp();

        await readSessionQuery();
        await readSessionQuery();

        expect(server.sessionReads).toHaveLength(1);

        await authClient.organization.setActive({ organizationId: "org_1" });
        await readSessionQuery();

        expect(server.sessionReads).toHaveLength(2);
    });

    it("another tab's sign-out (better-auth's storage broadcast) drops the shared read", async () => {
        const server = createFakeAuthServer(ADA);

        vi.stubGlobal("fetch", server.fetchImpl);

        const { readSessionQuery } = await bootApp();

        expect(userIdOf(await readSessionQuery())).toBe(ADA.id);

        // Another tab signed out: the server forgot the session, and better-auth posted its broadcast.
        server.setUser(null);
        globalThis.dispatchEvent(
            new StorageEvent("storage", { key: "better-auth.message", newValue: JSON.stringify({ data: { trigger: "signout" }, event: "session" }) }),
        );

        // Within the fresh window, yet not answered from the cache.
        expect(await readSessionQuery()).toBeNull();
    });
});

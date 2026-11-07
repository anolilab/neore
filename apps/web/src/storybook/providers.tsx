import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { LunoraClient } from "@lunora/client";
import { connectLiveQueries, createQueryClient } from "@neore/client-runtime";
import { DirectionProvider } from "@neore/ui/components/direction";
import { Toaster } from "@neore/ui/components/sonner";
import { TooltipProvider } from "@neore/ui/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { PostHogProvider } from "posthog-js/react";
import type { ReactNode } from "react";
import { createContext, use, useEffect, useMemo } from "react";

import { AuthQueryProvider } from "@/features/auth/lib/auth-query-provider";
import AuthUIProviderTanstack from "@/features/auth/lib/tanstack/auth-ui-provider-tanstack";
import ConnectionProvider from "@/features/connection/components/connection-provider";
import { authClient } from "@/lib/auth/client";
import { getSharedSessionRead } from "@/lib/auth/shared-session";
import env from "@/lib/env";
import { CRPCProvider } from "@/lib/lunora/crpc";

import { fakePostHog } from "./posthog";
import type { Persona } from "./session";
import { sessionFor } from "./session";

/** One Lingui instance for every story; the `locale` toolbar switches it (`loadStoryLocale` in a loader). */
const storyI18n = setupI18n();

export const loadStoryLocale = async (locale: string): Promise<void> => {
    // The same per-locale catalog import as `lib/intl/client.ts#dynamicActivate`, which imports server code.
    const { messages } = (await import(`../locales/${locale}/messages.po`)) as { messages: Record<string, string> };

    storyI18n.loadAndActivate({ locale, messages });
    // The translated words need the document's language too, or a screen reader pronounces them as English.
    document.documentElement.lang = locale;
};

const noop = (): void => {};

/**
 * A socket that never opens. Lunora's live subscriptions (`useQuery` from `@lunora/react`, the
 * chat's delta streams) then fall back to polling the same `/_lunora/rpc` the fixtures answer,
 * twice a second, so a stateful fixture shows up live without a socket protocol to mock.
 */
class NoSocket extends EventTarget {
    static readonly CLOSED = 3;

    static readonly CLOSING = 2;

    static readonly CONNECTING = 0;

    static readonly OPEN = 1;

    onclose: ((event: CloseEvent) => void) | null = null;

    onerror: ((event: Event) => void) | null = null;

    onmessage: ((event: MessageEvent) => void) | null = null;

    onopen: ((event: Event) => void) | null = null;

    readyState = NoSocket.CONNECTING;

    constructor() {
        super();
        queueMicrotask(() => {
            this.readyState = NoSocket.CLOSED;

            const error = new Event("error");
            const close = new CloseEvent("close", { code: 1006, reason: "Storybook has no socket" });

            this.onerror?.(error);
            this.dispatchEvent(error);
            this.onclose?.(close);
            this.dispatchEvent(close);
        });
    }

    close(): void {
        this.readyState = NoSocket.CLOSED;
    }

    send(): void {
        // Never open, so there is nothing to send: the client polls instead.
        this.readyState = NoSocket.CLOSED;
    }
}

/** What the connection banner sees (`useConnectionStatus`); a story sets `parameters.connection`. */
export type StoryConnection = "connected" | "connecting" | "offline" | "polling";

interface AppProvidersProps {
    children: ReactNode;
    connection: StoryConnection;
    direction: "ltr" | "rtl";
    /** PostHog flags that are on, from the story's `parameters.featureFlags`. */
    featureFlags: ReadonlyArray<string>;
    persona: Persona;
    theme: "dark" | "light";
}

interface SessionAtomValue {
    data: { user: { id: string } } | null;
    isPending: boolean;
}

/**
 * Resolves once better-auth's session atom holds `persona`'s session, for a loader to await so
 * the story renders signed in as that persona. The atom read once as its module loaded, which
 * can race the MSW worker (siblings of `.storybook/msw.ts` evaluate while it awaits), and it
 * outlives a story. A story played against a pending session acts as nobody: a save keyed on
 * the user id refuses.
 */
export const settleSession = async (persona: Persona): Promise<void> => {
    const atom = authClient.$store.atoms.session as { get: () => SessionAtomValue; listen: (listener: (value: SessionAtomValue) => void) => () => void };
    const expectedUserId = sessionFor(persona)?.user.id;
    const isSettled = (value: SessionAtomValue) => !value.isPending && value.data?.user.id === expectedUserId;

    if (isSettled(atom.get())) {
        return;
    }

    await new Promise<void>((resolve) => {
        const stop = atom.listen((value) => {
            if (!isSettled(value)) {
                return;
            }

            stop();
            resolve();
        });

        getSharedSessionRead()?.invalidate();
        authClient.$store.notify("$sessionSignal");
    });
};

/**
 * The app's provider stack, minus what needs a server: one fresh Query + Lunora client
 * per story (so no story sees another's cache), the persona's bearer on the Lunora client,
 * Lingui and a fake PostHog. Mirrors `routes/__root.tsx`.
 */
export const AppProviders = ({ children, connection, direction, featureFlags, persona, theme }: AppProvidersProps) => {
    const clients = useMemo(() => {
        const queryClient = createQueryClient();

        // A missing fixture should show as an error state at once, not after the retry backoff.
        queryClient.setDefaultOptions({ mutations: { retry: false }, queries: { refetchOnWindowFocus: false, retry: false } });

        const lunoraClient = new LunoraClient({
            pollingFallback: { afterFailedAttempts: 1, intervalMs: 500 },
            // No read cache: IndexedDB would carry one story's data into the next.
            queryCache: false,
            url: env.VITE_LUNORA_URL,
            // Only the members the client calls exist; it never reads the rest of the interface.
            WebSocket: NoSocket as unknown as typeof WebSocket,
        });

        // The socket never opens here (`NoSocket`), so the real status would always read "reconnecting".
        lunoraClient.onConnectionStatus = (listener) => {
            listener(connection);

            return noop;
        };

        const session = sessionFor(persona);

        if (session) {
            lunoraClient.setAuthToken(session.session.token);
        }

        return { lunoraClient, queryClient };
    }, [connection, persona]);

    // The app's live-query manager turns each `crpc` query into a subscription. The stories' socket never opens, so the
    // client's polling fallback is what carries a stateful fixture's change to those queries. A replaced client is
    // disconnected and closed (it must not keep reconnecting in the background) when the persona or connection changes.
    useEffect(() => {
        const disconnect = connectLiveQueries(clients.lunoraClient, clients.queryClient, async () => "storybook-ticket", { dev: false });

        return () => {
            disconnect();
            clients.lunoraClient.close();
        };
    }, [clients]);

    const posthog = useMemo(() => fakePostHog(featureFlags), [featureFlags]);

    return (
        <PostHogProvider client={posthog}>
            <I18nProvider i18n={storyI18n}>
                <DirectionProvider direction={direction}>
                    <QueryClientProvider client={clients.queryClient}>
                        <CRPCProvider client={clients.lunoraClient} queryClient={clients.queryClient}>
                            <AuthQueryProvider>
                                <AuthUIProviderTanstack authClient={authClient} navigate={noop} persistClient={false} replace={noop}>
                                    <ThemeProvider attribute="class" forcedTheme={theme}>
                                        <TooltipProvider>
                                            <ConnectionProvider>{children}</ConnectionProvider>
                                            <Toaster />
                                        </TooltipProvider>
                                    </ThemeProvider>
                                </AuthUIProviderTanstack>
                            </AuthQueryProvider>
                        </CRPCProvider>
                    </QueryClientProvider>
                </DirectionProvider>
            </I18nProvider>
        </PostHogProvider>
    );
};

const StoryContext = createContext<ReactNode>(null);

const StoryOutlet = () => use(StoryContext);

/**
 * A memory router around the story, so `Link`, `useNavigate` and `useLocation` work.
 * Every path matches the splat route, which renders the story; `path` sets the URL the
 * story starts on (a page story names its own route). The story reaches the route
 * through context, so an args change re-renders it without rebuilding the router.
 */
export const StoryRouter = ({ children, path }: { children: ReactNode; path: string }) => {
    const router = useMemo(() => {
        const rootRoute = createRootRoute({ component: Outlet });
        const indexRoute = createRoute({ component: StoryOutlet, getParentRoute: () => rootRoute, path: "/" });
        const splatRoute = createRoute({ component: StoryOutlet, getParentRoute: () => rootRoute, path: "$" });

        return createRouter({
            history: createMemoryHistory({ initialEntries: [path] }),
            routeTree: rootRoute.addChildren([indexRoute, splatRoute]),
        });
    }, [path]);

    return (
        <StoryContext value={children}>
            <RouterProvider router={router} />
        </StoryContext>
    );
};

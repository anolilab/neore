import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { LunoraClient } from "@lunora/client";
import { createQueryClient } from "@neore/client-runtime";
import { DirectionProvider } from "@neore/ui/components/direction";
import { Toaster } from "@neore/ui/components/sonner";
import { TooltipProvider } from "@neore/ui/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { PostHogProvider } from "posthog-js/react";
import type { ReactNode } from "react";
import { createContext, use, useMemo } from "react";

import { AuthQueryProvider } from "@/features/auth/lib/auth-query-provider";
import AuthUIProviderTanstack from "@/features/auth/lib/tanstack/auth-ui-provider-tanstack";
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
};

const noop = (): void => {};

interface AppProvidersProps {
    children: ReactNode;
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
export const AppProviders = ({ children, featureFlags, persona, theme }: AppProvidersProps) => {
    const clients = useMemo(() => {
        const queryClient = createQueryClient();

        // A missing fixture should show as an error state at once, not after the retry backoff.
        queryClient.setDefaultOptions({ mutations: { retry: false }, queries: { refetchOnWindowFocus: false, retry: false } });

        const lunoraClient = new LunoraClient({ url: env.VITE_LUNORA_URL });
        const session = sessionFor(persona);

        if (session) {
            lunoraClient.setAuthToken(session.session.token);
        }

        return { lunoraClient, queryClient };
    }, [persona]);
    const posthog = useMemo(() => fakePostHog(featureFlags), [featureFlags]);

    return (
        <PostHogProvider client={posthog}>
            <I18nProvider i18n={storyI18n}>
                <DirectionProvider direction="ltr">
                    <QueryClientProvider client={clients.queryClient}>
                        <CRPCProvider client={clients.lunoraClient} queryClient={clients.queryClient}>
                            <AuthQueryProvider>
                                <AuthUIProviderTanstack authClient={authClient} navigate={noop} persistClient={false} replace={noop}>
                                    <ThemeProvider attribute="class" forcedTheme={theme}>
                                        <TooltipProvider>
                                            {children}
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

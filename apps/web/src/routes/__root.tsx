/// <reference types="vite/client" />
import "unfonts.css";
// Imported for its boot-time read of the URL: see BOOTED_ON_CHAT_INDEX.
import "@/features/chat/core/utils/resume-boot";

import type { ConsentManagerOptions } from "@c15t/react";
import { ConsentManagerProvider } from "@c15t/react";
import { ConsentBanner } from "@c15t/react/components/consent-banner";
import { ConsentDialog } from "@c15t/react/components/consent-dialog";
import geistLatinFont from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useAuth } from "@lunora/react";
import { seedHydratedAuthToken, TOKEN_RETRY_DELAY_MS, tokenRefreshDelayMs } from "@neore/client-runtime";
import { IconSpriteSheet } from "@neore/ui/components/ai-elements/provider-icon";
import { CSPProvider } from "@neore/ui/components/csp-provider";
import { DirectionProvider } from "@neore/ui/components/direction";
import ScreenSizeDebug from "@neore/ui/components/screen-size-debug";
import { Toaster } from "@neore/ui/components/sonner";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouteContext, useRouter } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import type { SettingsTab } from "@/components/settings/settings-modal";
import ImpersonationBanner from "@/features/admin/components/impersonation-banner";
import AppearanceSync from "@/features/appearance/components/appearance-sync";
import { ACCENT_BOOT_SCRIPT } from "@/features/appearance/lib/accent-boot-script";
import { CHAT_TEXT_SIZE_BOOT_SCRIPT } from "@/features/appearance/lib/chat-text-size";
import { AuthQueryProvider } from "@/features/auth/lib/auth-query-provider";
import AuthUIProviderTanstack from "@/features/auth/lib/tanstack/auth-ui-provider-tanstack";
import ConnectionProvider from "@/features/connection/components/connection-provider";
import OfflineScreen from "@/features/connection/components/offline-screen";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import usePostHogIdentity from "@/hooks/use-posthog-identity";
import { authClient } from "@/lib/auth/client";
import getSessionToken, { getSessionAuthState } from "@/lib/auth/server-functions";
import env from "@/lib/env";
import { DEFAULT_LOCALE } from "@/lib/intl/client";
import { CRPCProvider, useLunora, useLunoraAuth } from "@/lib/lunora/crpc";
import { isNativeShell, setNativeBadge } from "@/lib/native/bridge";
import NativeBridge from "@/lib/native/native-bridge";
import { getClientPostHogState } from "@/lib/posthog/client-state";
import { forgetClientPostHog, readRequestContext, rememberClientPostHog } from "@/lib/request-context";
import { jsonLd, seo } from "@/lib/seo";
import { syncConsentToPostHog } from "@/providers/analytics-provider";
import type { AppContext } from "@/router";
import type { FileRouteTypes } from "@/routeTree.gen";
import appCss from "@/styles.css?url";

const TRAILING_SLASH_RE = /\/$/;

/**
 * Turns an auth-UI href such as `/auth/sign-in?redirectTo=/x` into a router target. The router
 * reads a string `to` as a bare pathname, so the query must become `search` or it is encoded
 * into the path and lost.
 */
const toRouteTarget = (href: string) => {
    const queryStart = href.indexOf("?");
    const rawPath = queryStart === -1 ? href : href.slice(0, queryStart);
    const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const to = normalizedPath.replaceAll(/\/+/g, "/") as FileRouteTypes["to"];

    if (queryStart === -1) {
        return { to };
    }

    return { search: Object.fromEntries(new URLSearchParams(href.slice(queryStart + 1))), to };
};

/** Keeps PostHog identity in sync with the current auth session. */
const PostHogIdentitySync = () => {
    usePostHogIdentity();

    return null;
};

const SettingsModal = lazy(() =>
    import("@/components/settings/settings-modal").then((m) => {
        return { default: m.SettingsModal };
    }),
);
const SwUpdatePrompt = lazy(() => import("@/components/sw-update-prompt"));
const ChangelogCard = lazy(() => import("@/features/changelog/components/changelog-card"));
const ChangelogPanel = lazy(() => import("@/features/changelog/components/changelog-panel"));

// Search params type for the root route
export interface RootSearchParams {
    settings?: boolean;
    settingsTab?: SettingsTab;
}

// Hoist static objects outside component to prevent re-renders (rerender-memo-with-default-value)
const API_KEY_CONFIG = {
    metadata: {
        environment: "production" as const,
        version: "v1",
    },
    prefix: "app_",
} as const;

const TWO_FACTOR_METHODS: ("otp" | "totp")[] = ["totp"];

/** Delay before the first re-attempt at RPC-token adoption; doubles per failure. */
const TOKEN_ADOPTION_RETRY_MS = 3000;

/** Ceiling for that backoff, so a token endpoint that stays down is polled at a fixed low rate. */
const TOKEN_ADOPTION_MAX_RETRY_MS = 30_000;

const CAPTCHA_CONFIG = env.VITE_TURNSTILE_SITE_KEY
    ? {
          provider: "cloudflare-turnstile" as const,
          siteKey: env.VITE_TURNSTILE_SITE_KEY,
      }
    : undefined;

/**
 * Warm the connections the first paint needs before the JS asks for them: the
 * backend (RPC batch, ws-ticket, live-query socket — credentialed CORS, hence
 * `use-credentials`, since browsers pool credentialed and anonymous
 * connections separately) and the gateway (`/v1/models`, anonymous CORS).
 * Each saves a DNS + TCP + TLS setup off the hydration critical path. Skipped
 * when an origin is the app's own, where the connection is already open.
 */
const PRECONNECT_LINKS = [
    { crossOrigin: "use-credentials" as const, href: new URL(env.VITE_LUNORA_URL).origin },
    { crossOrigin: "anonymous" as const, href: new URL(env.VITE_LLM_GATEWAY_URL).origin },
]
    .filter(({ href }) => href !== new URL(env.VITE_SITE_URL).origin)
    .map((link) => {
        return { ...link, rel: "preconnect" };
    });

const CONSENT_CATEGORIES: ("experience" | "functionality" | "marketing" | "measurement" | "necessary")[] = [
    "necessary",
    "functionality",
    "measurement",
    "marketing",
];

/**
 * Handles data refetching after authentication changes.
 * Monitors auth state transitions and refetches queries when:
 * 1. User logs in (unauthenticated → authenticated)
 * 2. Anonymous user logs in (anonymous → real user) - forces Lunora re-auth
 * 3. Auth recovers after reconnection
 * 4. Session is refreshed
 * Must be rendered inside CRPCProvider / LunoraProvider.
 */
const AuthRecovery = ({ children }: { children: ReactNode }) => {
    const { isLoading, isAuthenticated } = useLunoraAuth();
    // Whether the RPC client actually holds a token. NOT the same as
    // `isAuthenticated`: Lunora's identity probe answers from the session
    // cookie, so `isAuthenticated` can read true while every RPC goes out bare.
    const { token: rpcToken } = useAuth();
    const queryClient = useQueryClient();
    const lunoraClient = useLunora();
    const { data: sessionData } = authClient.useSession();
    const userIsAnonymous: boolean | null = sessionData?.user?.isAnonymous ?? null;

    const previousAuthStateRef = useRef<boolean | null>(null);
    const previousIsAnonymousRef = useRef<boolean | null>(null);
    const postLoginRefetchRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    // The post-login refetch timer below outlives the effect run that scheduled it on purpose —
    // a re-run must not cancel it — so it is released on unmount instead.
    useEffect(() => () => clearTimeout(postLoginRefetchRef.current), []);

    // Renew the RPC bearer before it expires (see `lib/lunora/token-refresh.ts`). Each new
    // token re-runs this effect with the new schedule. A failed renewal keeps the current token.
    useEffect(() => {
        if (rpcToken === null) {
            return undefined;
        }

        const delay = tokenRefreshDelayMs(rpcToken);

        if (delay === undefined) {
            return undefined;
        }

        let isCancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const scheduleRenewal = (wait: number) => {
            timer = setTimeout(async () => {
                try {
                    // The status tells an ended session apart from a failed read: only the first
                    // stops renewal. A `unknown` read (network, 429, 5xx) must be retried.
                    const { status, token } = await getSessionAuthState();

                    if (isCancelled) {
                        return;
                    }

                    if (status === "unauthenticated") {
                        // The session has ended: drop the bearer and stop renewing it.
                        lunoraClient.setAuthToken(null);

                        return;
                    }

                    // The server can answer the token it already minted (it caches for a minute).
                    // Setting the same string changes nothing, so the effect would never re-run
                    // and renewal would stop for this session. Treat it as a failed attempt.
                    if (token && token !== rpcToken) {
                        lunoraClient.setAuthToken(token);

                        return;
                    }

                    scheduleRenewal(TOKEN_RETRY_DELAY_MS);
                } catch {
                    if (!isCancelled) {
                        scheduleRenewal(TOKEN_RETRY_DELAY_MS);
                    }
                }
            }, wait);
        };

        scheduleRenewal(delay);

        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [rpcToken, lunoraClient]);

    /**
     * Forces the backend connection to re-authenticate with a fresh token.
     * Required when the user identity changes (e.g., anonymous → real user).
     */
    const forceLunoraReauth = useEffectEvent(() => {
        void (async () => {
            const token = await getSessionToken();

            lunoraClient.setAuthToken(token ?? null);
            queryClient.clear();
        })();
    });

    useEffect(() => {
        // Skip during initial load
        if (isLoading) {
            return;
        }

        const wasAuthenticated = previousAuthStateRef.current;
        const wasAnonymous = previousIsAnonymousRef.current;

        // User just logged in (was not authenticated, now is)
        if (wasAuthenticated === false && isAuthenticated) {
            console.log("[AuthRecovery] User logged in - refetching all active queries");

            // Small delay to let auth token propagate
            postLoginRefetchRef.current = setTimeout(() => {
                queryClient.refetchQueries({
                    type: "active",
                });
            }, 100);
        }
        // Anonymous user logged in as real user - force Lunora re-authentication
        else if (wasAnonymous === true && userIsAnonymous === false) {
            console.log("[AuthRecovery] Anonymous user authenticated - forcing Lunora re-auth");
            forceLunoraReauth();
        }
        // User logged out (was authenticated, now is not)
        else if (wasAuthenticated === true && !isAuthenticated) {
            console.log("[AuthRecovery] User logged out - clearing queries");
            queryClient.clear();
            // An expired session takes the bell with it, and no sign-out handler ran to clear the dock badge.
            void setNativeBadge(0);
        }

        previousAuthStateRef.current = isAuthenticated;
        previousIsAnonymousRef.current = userIsAnonymous;
    }, [isLoading, isAuthenticated, userIsAnonymous, queryClient]);

    /**
     * Adopt an existing session that the Lunora client has no token for.
     *
     * Gated on the client's TOKEN, not on `isAuthenticated`: the latter comes
     * from a cookie-backed identity probe and reads true for a tokenless
     * client, which used to skip this effect exactly when it was needed.
     * `beforeLoad` fetches a token on route loads, but a client-side sign-in
     * leaves a valid session paired with a tokenless client. Nothing else
     * recovers from that state.
     */
    useEffect(() => {
        const userId = sessionData?.user?.id;

        // Depend on the id, never on `sessionData.user` — that object is a fresh
        // identity on every render, so an effect keyed on it re-runs forever.
        // It did: this hammered `/api/auth/token` until the backend rate limiter
        // answered 429 and the dev server fell over.
        if (rpcToken !== null || !userId) {
            return undefined;
        }

        let isCancelled = false;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let delay = TOKEN_ADOPTION_RETRY_MS;

        // Retry inside the effect, on a timer it owns.
        //
        // A failed fetch leaves every dependency above unchanged, so the effect
        // does not re-run and nothing outside this closure will ever try again —
        // a retry that only flipped a ref would be dead code, because mutating a
        // ref schedules no render. Backing off (rather than a fixed interval)
        // keeps a token endpoint that is down for minutes from being polled at a
        // constant rate; the earlier version of this effect spun fast enough to
        // rate-limit itself into 429s.
        const attempt = () => {
            const adopt = async () => {
                const token = await getSessionToken();

                if (isCancelled) {
                    return;
                }

                if (token) {
                    // Sets `rpcToken`, which re-runs this effect and tears the
                    // chain down through the cleanup below.
                    lunoraClient.setAuthToken(token);
                } else {
                    scheduleRetry();
                }
            };

            void adopt().catch(() => {
                if (!isCancelled) {
                    scheduleRetry();
                }
            });
        };

        const scheduleRetry = () => {
            retry = setTimeout(attempt, delay);
            delay = Math.min(delay * 2, TOKEN_ADOPTION_MAX_RETRY_MS);
        };

        attempt();

        return () => {
            isCancelled = true;
            clearTimeout(retry);
        };
    }, [rpcToken, sessionData?.user?.id, lunoraClient]);

    return children;
};

const RootComponent = () => {
    const context = useRouteContext({ from: Route.id });

    // Before any child renders a query: hydration does not re-run `beforeLoad`
    // in the browser, so this is the only place the SSR token reaches the
    // browser's client. See `seedHydratedAuthToken`.
    seedHydratedAuthToken(context.lunoraClient, context.token);
    // The native bridge exists only in the browser, so it is read after mount: the
    // server and the first client render must match.
    const [isNative, setIsNative] = useState(false);

    useEffect(() => {
        setIsNative(isNativeShell());
    }, []);
    const router = useRouter();
    const { i18n } = useLingui();
    const direction = useUIStateStore((state) => state.layout.direction);
    const { posthog: renderedPostHog } = useRouteContext({ from: Route.id });

    useEffect(() => {
        rememberClientPostHog(renderedPostHog);
    }, [renderedPostHog]);

    // `<html dir>` is rendered from the persisted store, which a reload restores before the
    // first paint. Keep the attribute in step with the store, or the document stays LTR.
    useEffect(() => {
        document.documentElement.dir = direction;
    }, [direction]);

    // Memoize navigation callbacks to prevent AuthUIProviderTanstack re-renders
    const handleNavigate = useCallback(
        (href: string) => {
            router.navigate(toRouteTarget(href));
        },
        [router],
    );

    const handleReplace = useCallback(
        (href: string) => {
            router.navigate({ ...toRouteTarget(href), replace: true });
        },
        [router],
    );

    const handleSessionChange = useCallback(async () => {
        console.log("[Root] Session changed - invalidating router");

        // Load the flags of the identity that is now signed in before the routes reload. Without
        // this, a gate would read the previous account's flags, or none, until the next full load.
        try {
            rememberClientPostHog(await getClientPostHogState());
        } catch {
            forgetClientPostHog();
        }

        await router.invalidate();
    }, [router]);

    return (
        <html dir={direction} lang={i18n.locale ?? DEFAULT_LOCALE} suppressHydrationWarning>
            <head>
                <HeadContent />
            </head>
            <body className="isolate min-h-svh w-full" suppressHydrationWarning>
                <a
                    className="focus:bg-background focus:text-foreground focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[9999] focus:rounded-md focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2"
                    href="#main-content"
                >
                    <Trans>Skip to content</Trans>
                </a>
                <CSPProvider nonce={context.nonce}>
                    <DirectionProvider direction={direction}>
                        <QueryClientProvider client={context.queryClient}>
                            <CRPCProvider client={context.lunoraClient} queryClient={context.queryClient}>
                                <AuthRecovery>
                                    <AuthQueryProvider>
                                        <AuthUIProviderTanstack
                                            apiKey={API_KEY_CONFIG}
                                            authClient={authClient}
                                            captcha={CAPTCHA_CONFIG}
                                            navigate={handleNavigate}
                                            onSessionChange={handleSessionChange}
                                            persistClient={false}
                                            replace={handleReplace}
                                            twoFactor={TWO_FACTOR_METHODS}
                                        >
                                            <PostHogIdentitySync />
                                            <ThemeProvider attribute="class" defaultTheme="system" enableSystem nonce={context.nonce}>
                                                <ConsentManagerProvider
                                                    options={
                                                        {
                                                            mode: (env.VITE_C15T_MODE || "offline") as ConsentManagerOptions["mode"],
                                                            // This is the manager that actually runs. The
                                                            // callback used to be registered against a
                                                            // throwaway one in `analytics-provider`, so a
                                                            // consent decision never reached PostHog.
                                                            callbacks: { onConsentSet: syncConsentToPostHog },
                                                            consentCategories: CONSENT_CATEGORIES,
                                                            ignoreGeoLocation: import.meta.env.DEV,
                                                        } as ConsentManagerOptions
                                                    }
                                                >
                                                    <ImpersonationBanner />
                                                    <ConnectionProvider>
                                                        {/* Eager, not lazy: a lazy chunk cannot load while the app is offline, which is when this screen is needed. */}
                                                        {isNative && <OfflineScreen />}
                                                        <ScreenSizeDebug />
                                                        <Outlet />
                                                    </ConnectionProvider>
                                                    <Suspense fallback={null}>
                                                        <SettingsModal />
                                                    </Suspense>
                                                    <Suspense fallback={null}>
                                                        <SwUpdatePrompt />
                                                    </Suspense>
                                                    <Toaster />
                                                    <NativeBridge />
                                                    <AppearanceSync />
                                                    <Suspense fallback={null}>
                                                        <ChangelogCard />
                                                    </Suspense>
                                                    <Suspense fallback={null}>
                                                        <ChangelogPanel />
                                                    </Suspense>
                                                    <ConsentBanner />
                                                    <ConsentDialog />
                                                    <Scripts />
                                                    <IconSpriteSheet />
                                                </ConsentManagerProvider>
                                            </ThemeProvider>
                                        </AuthUIProviderTanstack>
                                    </AuthQueryProvider>
                                </AuthRecovery>
                            </CRPCProvider>
                        </QueryClientProvider>
                    </DirectionProvider>
                </CSPProvider>
            </body>
        </html>
    );
};

export const Route = createRootRouteWithContext<AppContext>()({
    validateSearch: (search: Record<string, unknown>): RootSearchParams => {
        return {
            settings: search.settings === true || search.settings === "true" || undefined,
            settingsTab: search.settingsTab as SettingsTab | undefined,
        };
    },
    beforeLoad: async (context) => {
        // CSP nonce (security-middleware) and PostHog flags (posthog-middleware)
        // arrive as `serverContext`, not on the router context — see
        // `readRequestContext`. Read in parallel with the token: during SSR both
        // are network round trips on the TTFB path.
        // A failed token read (offline, 5xx, network) is `unknown`, not a thrown error: a throw
        // here replaces the whole document with the error component.
        const [{ status: authStatus, token }, { nonce, posthog }] = await Promise.all([
            getSessionAuthState().catch(() => {
                return { status: "unknown" as const, token: undefined };
            }),
            readRequestContext(context),
        ]);

        if (token) {
            context.context.lunoraClient.setAuthToken(token);
        }

        return {
            // `unknown` = the token fetch FAILED (429/5xx/network) for a request with a
            // session cookie. Guards redirect only on `unauthenticated` — see `lib/auth/route-guard.ts`.
            authStatus,
            isAuthenticated: !!token,
            nonce,
            token,
            posthog,
        };
    },
    component: RootComponent,
    head: ({ loaderData, match }) => {
        // Get PostHog data from loader.
        // The root route has no `loader`, so `loaderData` is typed `undefined`; the value actually
        // present here is the `beforeLoad` context (see above), which carries `posthog`.
        const posthogData = (loaderData as { posthog?: { distinctId: string | null; flags: Record<string, boolean | string> } } | undefined)?.posthog;

        const metaTags = [
            {
                // eslint-disable-next-line unicorn/text-encoding-identifier-case
                charSet: "utf-8",
            },
            {
                content: "width=device-width, initial-scale=1",
                name: "viewport",
            },
            ...seo({
                description: match.context.i18n._(
                    msg`Neore Chat is a modern AI chat application. Chat with the latest AI models, organise your conversations, and stay productive.`,
                ),
                image: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/og.png`,
                keywords: "AI chat, ChatGPT alternative, Claude, AI assistant, productivity",
                noIndex: true, // default to noindex; public pages override via their own head()
                title: "Neore Chat",
            }),
        ];

        // Add PostHog data as meta tag if available
        if (posthogData && posthogData.distinctId) {
            metaTags.push({
                content: JSON.stringify({
                    distinctId: posthogData.distinctId,
                    flags: posthogData.flags ?? {},
                }),
                name: "posthog-data",
            });
        }

        return {
            links: [
                ...PRECONNECT_LINKS,
                { href: appCss, rel: "stylesheet" },
                // The body face (`--font-sans`, latin subset) — the same file `unplugin-fonts`
                // emits, so the same hashed asset. Without this the browser finds it only
                // after the stylesheet has downloaded and parsed.
                { as: "font", crossOrigin: "anonymous", href: geistLatinFont, rel: "preload", type: "font/woff2" },
                { href: "/favicon.ico", rel: "icon" },
                { href: "/manifest.json", rel: "manifest" },
                { href: "/pwa-icon-192x192.png", rel: "apple-touch-icon", sizes: "192x192" },
            ],
            meta: [
                ...metaTags,
                { content: "#191919", name: "theme-color" },
                { content: "yes", name: "mobile-web-app-capable" },
                { content: "yes", name: "apple-mobile-web-app-capable" },
                { content: "default", name: "apple-mobile-web-app-status-bar-style" },
                { content: "Neore Chat", name: "apple-mobile-web-app-title" },
            ],
            scripts: [
                // Applies the stored accent colour before first paint (no flash); carries the CSP nonce.
                { children: ACCENT_BOOT_SCRIPT },
                // Same for the chat text size.
                { children: CHAT_TEXT_SIZE_BOOT_SCRIPT },
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "WebSite",
                    name: "Neore Chat",
                    url: env.VITE_SITE_URL,
                    publisher: {
                        "@type": "Organization",
                        name: "Neore",
                        url: env.VITE_SITE_URL,
                        logo: `${env.VITE_SITE_URL}/pwa-icon-192x192.png`,
                    },
                }),
            ],
        };
    },
});

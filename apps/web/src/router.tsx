import type { I18n } from "@lingui/core";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { LunoraClient } from "@lunora/client";
import { createRouter as createTanstackRouter, ErrorComponent } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { getGlobalStartContext } from "@tanstack/react-start";
import type { ReactNode } from "react";

import DefaultLoading from "@/components/default-loading";
import GlobalErrorBoundaryProvider from "@/components/error-boundaries/global-error-boundary-provider";
import NotFound from "@/components/not-found";
import { createIdentityProbeFetch } from "@/lib/auth/shared-session";
import env from "@/lib/env";
import { deLocalizeUrl, localizeUrl } from "@/lib/intl/client";
import AnalyticsProvider from "@/providers/analytics-provider";

import routerWithLingui from "./lib/intl/router-plugin";
import { connectLiveQueries } from "./lib/lunora/live-queries";
import { createQueryClient } from "./lib/lunora/query-client";
import { createWsTicketMinter } from "./lib/lunora/ws-ticket";
import { routeTree } from "./routeTree.gen";

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}

export interface AppContext {
    i18n: I18n;
    lunoraClient: LunoraClient;
    queryClient: ReturnType<typeof createQueryClient>;
}

export const getRouter = (): ReturnType<typeof createTanstackRouter> => {
    const context = getGlobalStartContext() as { i18n?: I18n; security?: { nonce?: string } } | undefined;
    const i18n = context?.i18n ?? setupI18n();
    // Per-request CSP nonce from `security-middleware.ts` (server only). The
    // router stamps it on every inline script it and React emit — Start's
    // dehydration payload, `<Scripts>`/`<HeadContent>` assets, React's
    // streaming Suspense scripts — and HeadContent writes it to
    // `<meta property="csp-nonce">`, which the client router reads back on
    // hydration. Without it the enforced `script-src` blocks hydration.
    const nonce = context?.security?.nonce;

    // Lunora's identity probe reads ANY non-2xx `get-session` answer as "nobody",
    // so a rate-limited (429) probe settled a signed-in user as unauthenticated
    // and `<Authenticated>` hid the page. Retry it, and when it still fails,
    // THROW: a thrown probe settles as `unreachable`, which keeps the last known
    // identity. Every other request passes through. See `lib/auth/session-read.ts`.
    //
    // In the browser the probe does not make its own read: it joins the one
    // session read better-auth's client makes on the app origin
    // (`lib/auth/shared-session.ts`), so a page load reads the session once,
    // not three times. `undefined` on the server, where nothing may be shared.
    const lunora = new LunoraClient({
        fetch: createIdentityProbeFetch(fetch.bind(globalThis)),
        url: env.VITE_LUNORA_URL,
    });

    const queryClient = createQueryClient();

    // `crpc` queries are live subscriptions in the browser (a no-op on the
    // server, where each query fetches once and is dehydrated).
    // The socket authenticates with a single-use ticket minted per connect,
    // never the JWT (see `lib/lunora/ws-ticket.ts`).
    connectLiveQueries(lunora, queryClient, createWsTicketMinter(env.VITE_LUNORA_URL));

    const router = createTanstackRouter({
        context: {
            i18n,
            lunoraClient: lunora,
            queryClient,
        },
        defaultErrorComponent: ({ error }) => <ErrorComponent error={error} />,
        defaultHashScrollIntoView: { behavior: "auto" },
        defaultNotFoundComponent: NotFound,
        defaultPendingComponent: DefaultLoading,
        defaultPendingMinMs: 500,
        // Only show pending component if navigation takes >3000ms (almost never)
        defaultPendingMs: 3000,
        defaultPreload: "intent",
        // Cache Single Source Pattern: Make TanStack Query the authoritative cache
        defaultPreloadStaleTime: 0,
        defaultStructuralSharing: true,
        defaultViewTransition: true,
        rewrite: {
            input: deLocalizeUrl,
            output: localizeUrl,
        },
        routeTree,
        scrollRestoration: false,
        ...(nonce && { ssr: { nonce } }),
        Wrap: ({ children }: { children: ReactNode }) => (
            <GlobalErrorBoundaryProvider>
                <I18nProvider i18n={i18n}>
                    <AnalyticsProvider>{children}</AnalyticsProvider>
                </I18nProvider>
            </GlobalErrorBoundaryProvider>
        ),
    });

    setupRouterSsrQueryIntegration({
        queryClient,
        router,
    });

    // `getRouter`'s declared return type is deliberately the widened `createTanstackRouter`
    // return: `Register` above is defined as `ReturnType<typeof getRouter>`, so annotating the
    // concrete router type here would be circular. Passing `router` un-erased still lets
    // `ValidateRouter` check that the context carries `i18n` (a plain `as any` skipped that).
    return routerWithLingui<typeof router>(router, i18n) as unknown as ReturnType<typeof createTanstackRouter>;
};

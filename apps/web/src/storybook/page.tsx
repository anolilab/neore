import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { AnyRoute, RouteComponent } from "@tanstack/react-router";
import { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { useMemo } from "react";

import { useLunora } from "@/lib/lunora/crpc";

import { getActivePersona, sessionFor } from "./session";

/**
 * One level of a page, at the path it has under its parent, or `id` for a pathless layout such
 * as `(chat)`. Pass the file `route` itself, so the story renders what the app renders: its
 * component, its search validation and its loader. Or pass only a `component`.
 *
 * Route IDs are built from these the way the generator builds them, so a component that reads
 * `Route.useParams()` / `useSearch()` / `useLoaderData()` from its own file finds its match when
 * the levels follow the route's folders.
 */
export type PageLevel = { component?: RouteComponent; route?: AnyRoute } & ({ id: string; path?: never } | { id?: never; path: string });

interface StoryPageProps {
    /** Outermost first: the layout routes, then the page. */
    levels: ReadonlyArray<PageLevel>;
    /** The URL the page opens on, e.g. `/dashboard/settings/chat/model-filters`. */
    url: string;
}

/** The parts of a file route a story takes over; `beforeLoad` is left out on purpose (below). */
const fromRoute = (route: AnyRoute | undefined) => {
    if (!route) {
        return {};
    }

    const { component, loader, loaderDeps, validateSearch } = route.options as {
        component?: unknown;
        loader?: unknown;
        loaderDeps?: unknown;
        validateSearch?: unknown;
    };

    return { component, loader, loaderDeps, validateSearch };
};

/**
 * A page in Storybook: the real layout and page routes in a memory router at `url`, with the
 * router context the app gives them (the story's Lunora and Query clients, Lingui, the persona's
 * auth state), so their loaders run against the MSW fixtures too. `beforeLoad` is left out: the
 * guards read the server session and redirect, and a story names the page it wants.
 */
export const StoryPage = ({ levels, url }: StoryPageProps) => {
    const queryClient = useQueryClient();
    const lunoraClient = useLunora();
    const { i18n } = useLingui();

    const router = useMemo(() => {
        const isAuthenticated = sessionFor(getActivePersona()) !== null;
        const rootRoute = createRootRouteWithContext<Record<string, unknown>>()({ component: Outlet });
        let parent: AnyRoute = rootRoute;
        const chain: AnyRoute[] = [];

        for (const level of levels) {
            const owner = parent;
            const taken = fromRoute(level.route);
            const shared = { ...taken, component: level.component ?? (taken.component as RouteComponent | undefined) ?? Outlet, getParentRoute: () => owner };
            const route = createRoute((level.path === undefined ? { ...shared, id: level.id } : { ...shared, path: level.path }) as never) as AnyRoute;

            chain.push(route);
            parent = route;
        }

        // Nest the chain: each route's only child is the next one.
        for (let index = chain.length - 2; index >= 0; index -= 1) {
            const current = chain[index];
            const next = chain[index + 1];

            if (current && next) {
                current.addChildren([next]);
            }
        }

        const [first] = chain;

        return createRouter({
            context: { authStatus: isAuthenticated ? "authenticated" : "unauthenticated", i18n, isAuthenticated, lunoraClient, queryClient },
            history: createMemoryHistory({ initialEntries: [url] }),
            routeTree: first ? rootRoute.addChildren([first]) : rootRoute,
        });
    }, [i18n, levels, lunoraClient, queryClient, url]);

    return <RouterProvider router={router} />;
};

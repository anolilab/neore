import type { AnyRoute, RouteComponent } from "@tanstack/react-router";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { useMemo } from "react";

/**
 * One level of a page: the component a file route renders (take it from the route,
 * `Route.options.component`, so the story renders what the app renders) and the path it
 * has under its parent, or `id` for a pathless layout such as `(chat)`.
 *
 * Route IDs are built from these the way the generator builds them, so a component that
 * reads `Route.useParams()` / `useSearch()` from its own file finds its match when the
 * levels follow the route's folders.
 */
export type PageLevel = { component?: RouteComponent; id: string; path?: never } | { component?: RouteComponent; id?: never; path: string };

interface StoryPageProps {
    /** Outermost first: the layout routes, then the page. */
    levels: ReadonlyArray<PageLevel>;
    /** The URL the page opens on, e.g. `/dashboard/settings/chat/model-filters`. */
    url: string;
}

/**
 * A page in Storybook: the real layout and page components in a memory router at `url`.
 * Loaders and `beforeLoad` are left out on purpose: route guards read a server session and
 * loaders prefetch through the Lunora client, while the components fetch the same data
 * through `crpc`, which the story's MSW fixtures answer.
 */
export const StoryPage = ({ levels, url }: StoryPageProps) => {
    const router = useMemo(() => {
        const rootRoute = createRootRoute({ component: Outlet });
        let parent: AnyRoute = rootRoute;
        const chain: AnyRoute[] = [];

        for (const level of levels) {
            const owner = parent;
            const shared = { component: level.component ?? Outlet, getParentRoute: () => owner };
            const route: AnyRoute = createRoute(level.path === undefined ? { ...shared, id: level.id } : { ...shared, path: level.path });

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
            history: createMemoryHistory({ initialEntries: [url] }),
            routeTree: first ? rootRoute.addChildren([first]) : rootRoute,
        });
    }, [levels, url]);

    return <RouterProvider router={router} />;
};

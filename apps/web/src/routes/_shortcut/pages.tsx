import { createFileRoute, Outlet } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import PagesSidebar from "@/features/pages/components/pages-sidebar";

export const Route = createFileRoute("/_shortcut/pages")({
    component: () => (
        <RouteErrorBoundary routeName="/pages">
            <div className="flex h-full min-h-0 w-full">
                <PagesSidebar />
                <main className="flex min-w-0 flex-1">
                    <Outlet />
                </main>
            </div>
        </RouteErrorBoundary>
    ),
});

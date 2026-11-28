import { createFileRoute, Outlet } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import PagesLayout from "@/features/pages/components/pages-layout";

export const Route = createFileRoute("/_shortcut/pages")({
    component: () => (
        <RouteErrorBoundary routeName="/pages">
            <PagesLayout>
                <Outlet />
            </PagesLayout>
        </RouteErrorBoundary>
    ),
});

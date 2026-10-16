import { createFileRoute } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import HomePage from "@/features/home/components/home-page";
import { requireSession } from "@/lib/auth/route-guard";

export const Route = createFileRoute("/dashboard/")({
    beforeLoad: ({ context, location }) => {
        requireSession(context, location);
    },
    component: () => (
        <RouteErrorBoundary routeName="/dashboard">
            <HomePage />
        </RouteErrorBoundary>
    ),
});

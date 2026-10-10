import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import EvalsPage from "@/features/evals/components/evals-page";

export const Route = createFileRoute("/_shortcut/evals")({
    component: () => (
        <RouteErrorBoundary routeName="/evals">
            <ScrollArea className="h-full w-full p-4">
                <EvalsPage />
            </ScrollArea>
        </RouteErrorBoundary>
    ),
});

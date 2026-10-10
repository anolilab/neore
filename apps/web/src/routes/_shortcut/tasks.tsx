import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import TasksPage from "@/features/tasks/components/tasks-page";

export const Route = createFileRoute("/_shortcut/tasks")({
    component: () => (
        <RouteErrorBoundary routeName="/tasks">
            <ScrollArea className="h-full w-full p-4">
                <TasksPage />
            </ScrollArea>
        </RouteErrorBoundary>
    ),
});

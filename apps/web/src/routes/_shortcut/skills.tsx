import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import SkillsPage from "@/features/skills/components/skills-page";

export const Route = createFileRoute("/_shortcut/skills")({
    component: () => (
        <RouteErrorBoundary routeName="/skills">
            <ScrollArea className="h-full w-full p-4">
                <SkillsPage />
            </ScrollArea>
        </RouteErrorBoundary>
    ),
});

import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import PromptHeader from "@/features/prompts/components/prompt-header";
import PromptList from "@/features/prompts/components/prompt-list";

export const Route = createFileRoute("/_shortcut/prompts")({
    component: () => (
        <RouteErrorBoundary routeName="/prompts">
            <ScrollArea className="h-full w-full p-4">
                <div className="space-y-6">
                    <PromptHeader />
                    <PromptList />
                </div>
            </ScrollArea>
        </RouteErrorBoundary>
    ),
});

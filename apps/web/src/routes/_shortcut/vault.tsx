import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import VaultHeader from "@/features/vault/components/header";
import VaultView from "@/features/vault/components/view";

export const Route = createFileRoute("/_shortcut/vault")({
    component: () => (
        <RouteErrorBoundary routeName="/vault">
            <ScrollArea className="h-full w-full p-4">
                <div className="space-y-6">
                    <VaultHeader />
                    <VaultView />
                </div>
            </ScrollArea>
        </RouteErrorBoundary>
    ),
});

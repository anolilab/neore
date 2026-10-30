import { ScrollArea } from "@neore/ui/components/scroll-area";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import DevelopPage from "@/features/develop/components/develop-page";
import { validateDevelopSearch } from "@/features/develop/lib/search";

const DevelopRoute = () => {
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });

    return (
        <RouteErrorBoundary routeName="/develop">
            <ScrollArea className="h-full w-full p-4">
                <DevelopPage onSearchChange={(next) => navigate({ search: next })} search={search} />
            </ScrollArea>
        </RouteErrorBoundary>
    );
};

export const Route = createFileRoute("/_shortcut/develop")({
    component: DevelopRoute,
    validateSearch: validateDevelopSearch,
});

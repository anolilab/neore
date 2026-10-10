import { createFileRoute } from "@tanstack/react-router";

import OrganizationsCard from "@/features/auth/components/organization/organizations-card";
import { requireSession } from "@/lib/auth/route-guard";

const RouteComponent = () => <OrganizationsCard />;

export const Route = createFileRoute("/dashboard/settings/auth/organizations")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    component: RouteComponent,
});

import { createFileRoute } from "@tanstack/react-router";

import OrganizationSettingsCards from "@/features/auth/components/organization/organization-settings-cards";
import { requireSession } from "@/lib/auth/route-guard";

const RouteComponent = () => <OrganizationSettingsCards />;

export const Route = createFileRoute("/dashboard/settings/auth/organization")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    component: RouteComponent,
});

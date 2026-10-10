import { createFileRoute } from "@tanstack/react-router";

import SecuritySettingsCards from "@/features/auth/components/settings/security-settings-cards";
import { requireSession } from "@/lib/auth/route-guard";

const RouteComponent = () => <SecuritySettingsCards />;

export const Route = createFileRoute("/dashboard/settings/auth/security")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    component: RouteComponent,
});

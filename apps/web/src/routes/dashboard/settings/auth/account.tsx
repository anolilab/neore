import { createFileRoute } from "@tanstack/react-router";

import AccountSettingsCards from "@/features/auth/components/settings/account-settings-cards";
import { requireSession } from "@/lib/auth/route-guard";

const RouteComponent = () => <AccountSettingsCards />;

export const Route = createFileRoute("/dashboard/settings/auth/account")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    component: RouteComponent,
});

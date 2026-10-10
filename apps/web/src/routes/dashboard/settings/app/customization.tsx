import { createFileRoute } from "@tanstack/react-router";

import AccountSettings from "@/features/settings/components/account/account-settings";

export const Route = createFileRoute("/dashboard/settings/app/customization")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    component: AccountSettings,
});

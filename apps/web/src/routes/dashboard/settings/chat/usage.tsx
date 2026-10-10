import { createFileRoute } from "@tanstack/react-router";

import UsageSettings from "@/features/settings/components/chat/usage-settings";

export const Route = createFileRoute("/dashboard/settings/chat/usage")({
    preloadStaleTime: 60_000,
    component: UsageSettings,
});

import { createFileRoute } from "@tanstack/react-router";

import BotsSettings from "@/features/settings/components/chat/bots-settings";

export const Route = createFileRoute("/dashboard/settings/chat/bots")({
    preloadStaleTime: 10_000,
    component: BotsSettings,
});

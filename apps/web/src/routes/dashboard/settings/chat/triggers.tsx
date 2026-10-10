import { createFileRoute } from "@tanstack/react-router";

import TriggerSettings from "@/features/settings/components/chat/trigger-settings";

export const Route = createFileRoute("/dashboard/settings/chat/triggers")({
    preloadStaleTime: 10_000,
    component: TriggerSettings,
});

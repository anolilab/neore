import { createFileRoute } from "@tanstack/react-router";

import PersonalizationSettings from "@/features/settings/components/personalization/personalization-settings";

export const Route = createFileRoute("/dashboard/settings/app/personalization")({
    preloadStaleTime: 10_000,
    component: PersonalizationSettings,
});

import { createFileRoute } from "@tanstack/react-router";

import ModelFilterSettings from "@/features/settings/components/chat/model-filter-settings";

export const Route = createFileRoute("/dashboard/settings/chat/model-filters")({
    preloadStaleTime: 10_000,
    component: ModelFilterSettings,
});

import { createFileRoute } from "@tanstack/react-router";

import ModelsSettings from "@/features/settings/components/chat/models-settings";

export const Route = createFileRoute("/dashboard/settings/chat/models")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    component: ModelsSettings,
});

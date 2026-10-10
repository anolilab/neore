import { createFileRoute } from "@tanstack/react-router";

import KnowledgeBaseSettings from "@/features/settings/components/knowledge/knowledge-base-settings";

export const Route = createFileRoute("/dashboard/settings/chat/knowledge")({
    preloadStaleTime: 10_000,
    component: KnowledgeBaseSettings,
});

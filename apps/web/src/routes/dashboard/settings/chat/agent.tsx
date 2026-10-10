import { createFileRoute } from "@tanstack/react-router";

import AgentSettings from "@/features/settings/components/chat/agent-settings";

export const Route = createFileRoute("/dashboard/settings/chat/agent")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    component: AgentSettings,
});

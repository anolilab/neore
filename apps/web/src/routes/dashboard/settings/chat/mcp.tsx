import { createFileRoute } from "@tanstack/react-router";

import MCPSettings from "@/features/settings/components/chat/mcp-settings";

export const Route = createFileRoute("/dashboard/settings/chat/mcp")({
    preloadStaleTime: 10_000,
    component: MCPSettings,
});

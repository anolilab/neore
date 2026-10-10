import { createFileRoute } from "@tanstack/react-router";

import DevicesSettings from "@/features/devices/components/devices-settings";

export const Route = createFileRoute("/dashboard/settings/chat/devices")({
    preloadStaleTime: 10_000,
    component: DevicesSettings,
});

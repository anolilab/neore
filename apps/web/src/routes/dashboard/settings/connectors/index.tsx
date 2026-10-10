import { createFileRoute } from "@tanstack/react-router";

import ConnectorsPage from "@/features/settings/connectors/connectors-page";

export const Route = createFileRoute("/dashboard/settings/connectors/")({
    component: ConnectorsPage,
});

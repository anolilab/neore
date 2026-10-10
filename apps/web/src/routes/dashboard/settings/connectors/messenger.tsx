import { createFileRoute } from "@tanstack/react-router";

import MessengerPage from "@/features/settings/connectors/messenger/messenger-page";

export const Route = createFileRoute("/dashboard/settings/connectors/messenger")({
    component: MessengerPage,
});

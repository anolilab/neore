import { createFileRoute } from "@tanstack/react-router";

import TeamsCard from "@/features/auth/components/team/teams-card";
import { requireSession } from "@/lib/auth/route-guard";

const RouteComponent = () => <TeamsCard />;

export const Route = createFileRoute("/dashboard/settings/auth/teams")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    component: RouteComponent,
});

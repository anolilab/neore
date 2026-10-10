import { createFileRoute } from "@tanstack/react-router";

import APIKeysCard from "@/features/auth/components/settings/api-key/api-keys-card";
import { requireSession } from "@/lib/auth/route-guard";

const RouteComponent = () => <APIKeysCard />;

export const Route = createFileRoute("/dashboard/settings/auth/api-keys")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    component: RouteComponent,
});

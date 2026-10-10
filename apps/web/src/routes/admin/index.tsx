import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import AdminDashboardStats from "@/features/admin/components/admin-dashboard-stats";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";
import { referenceNow } from "@/lib/reference-time";

const RouteComponent = () => <AdminDashboardStats />;

export const Route = createFileRoute("/admin/")({
    preloadStaleTime: 10_000,
    loader: async ({ context }) => {
        try {
            await context.queryClient.ensureQueryData(
                createLunoraQueryOptions(context.lunoraClient, api.auth.admin.getDashboardStats, { now: referenceNow() }),
            );
        } catch {
            // Data will be fetched on mount if preload fails
        }
    },
    component: RouteComponent,
});

import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import AdminDashboardStats from "@/features/admin/components/admin-dashboard-stats";
import AdminShardFootprintRow from "@/features/admin/components/admin-shard-footprint-row";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";
import { referenceNow } from "@/lib/reference-time";

const RouteComponent = () => (
    <div className="flex flex-col gap-6">
        <AdminDashboardStats />
        <AdminShardFootprintRow />
    </div>
);

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

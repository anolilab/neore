import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import AdminCleanupDashboard from "@/features/admin/components/admin-cleanup-dashboard";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";
import { referenceNow } from "@/lib/reference-time";

const RouteComponent = () => <AdminCleanupDashboard />;

export const Route = createFileRoute("/admin/cleanup")({
    preloadStaleTime: 10_000,
    loader: async ({ context }) => {
        const now = referenceNow();

        try {
            await Promise.all([
                context.queryClient.ensureQueryData(createLunoraQueryOptions(context.lunoraClient, api.admin.cleanup.getCleanupConfig, {})),
                context.queryClient.ensureQueryData(createLunoraQueryOptions(context.lunoraClient, api.admin.cleanup.previewCleanup, { now })),
                context.queryClient.ensureQueryData(
                    createLunoraQueryOptions(context.lunoraClient, api.admin.cleanup.listCleanupLogs, { cursor: null, limit: 20 }),
                ),
            ]);
        } catch {
            // Data will be fetched on mount if preload fails
        }
    },
    component: RouteComponent,
});

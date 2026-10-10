import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import AuditLogCard from "@/features/admin/components/audit-log-card";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";

const RouteComponent = () => <AuditLogCard />;

export const Route = createFileRoute("/admin/audit-log")({
    preloadStaleTime: 10_000,
    loader: async ({ context }) => {
        try {
            await context.queryClient.ensureQueryData(
                createLunoraQueryOptions(context.lunoraClient, api.admin.audit_log.getAuditLogs, {
                    action: undefined,
                    cursor: null,
                    limit: 50,
                }),
            );
        } catch {
            // Data will be fetched on mount if preload fails
        }
    },
    component: RouteComponent,
});

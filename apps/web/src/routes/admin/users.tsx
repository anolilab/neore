import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import UsersManagementCard from "@/features/admin/components/users-management-card";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";

const RouteComponent = () => <UsersManagementCard context="admin" />;

export const Route = createFileRoute("/admin/users")({
    preloadStaleTime: 10_000,
    loader: async ({ context }) => {
        try {
            await context.queryClient.ensureQueryData(
                createLunoraQueryOptions(context.lunoraClient, api.auth.admin.getAllUsers, {
                    cursor: null,
                    limit: 20,
                }),
            );
        } catch {
            // Data will be fetched on mount if preload fails
        }
    },
    component: RouteComponent,
});

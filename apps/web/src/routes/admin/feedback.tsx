import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import FeedbackAdminPage, { FEEDBACK_PAGE_SIZE } from "@/features/admin/components/feedback-admin-page";
import { createLunoraQueryOptions } from "@/lib/lunora/crpc";

const RouteComponent = () => <FeedbackAdminPage />;

export const Route = createFileRoute("/admin/feedback")({
    preloadStaleTime: 10_000,
    loader: async ({ context }) => {
        try {
            await context.queryClient.ensureQueryData(
                createLunoraQueryOptions(context.lunoraClient, api.feedback.admin.listFeedback, { cursor: null, kind: undefined, limit: FEEDBACK_PAGE_SIZE }),
            );
        } catch {
            // Fetched on mount when the preload fails.
        }
    },
    component: RouteComponent,
});

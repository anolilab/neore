import { createFileRoute } from "@tanstack/react-router";

import NsfwReviewPage from "@/features/admin/components/nsfw-review-page";

const RouteComponent = () => <NsfwReviewPage />;

export const Route = createFileRoute("/admin/nsfw-review")({
    component: RouteComponent,
});

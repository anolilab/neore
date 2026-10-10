import { createFileRoute } from "@tanstack/react-router";

import OrganizationInvitationsCard from "@/features/auth/components/organization/organization-invitations-card";
import OrganizationMembersCard from "@/features/auth/components/organization/organization-members-card";
import { requireSession } from "@/lib/auth/route-guard";

const RouteComponent = () => (
    <>
        <OrganizationMembersCard />

        <OrganizationInvitationsCard />
    </>
);

export const Route = createFileRoute("/dashboard/settings/auth/members")({
    // Preload cache stays fresh for 10 seconds - prevents validation from running on every hover
    preloadStaleTime: 10_000,
    beforeLoad: ({ context }) => {
        requireSession(context);
    },
    component: RouteComponent,
});

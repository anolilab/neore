import { createFileRoute } from "@tanstack/react-router";

import PageInviteAccept from "@/features/pages/components/page-invite-accept";

const PageInviteRoute = () => {
    const { token } = Route.useParams();

    return <PageInviteAccept token={token} />;
};

export const Route = createFileRoute("/_shortcut/pages/invite/$token")({
    component: PageInviteRoute,
    // The token is a bearer credential.
    head: () => {
        return { meta: [{ content: "noindex, nofollow", name: "robots" }] };
    },
});

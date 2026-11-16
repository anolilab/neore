import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import GuestPage from "@/features/chat/guest-links/guest-page";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/(public)/guest")({
    component: GuestPage,
    head: ({ match }) => {
        return {
            // The link token is a bearer credential in the fragment: never indexed.
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Leave a message`) }),
        };
    },
});

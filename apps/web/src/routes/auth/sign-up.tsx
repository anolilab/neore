import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import AuthCard from "@/features/auth/components/auth/auth-card";
import { seo } from "@/lib/seo";

const RouteComponent = () => <AuthCard view="SIGN_UP" />;

export const Route = createFileRoute("/auth/sign-up")({
    component: RouteComponent,

    /**
     * Registration is invite-only, and the token arrives as `?invite=`. It is
     * declared here so the parameter survives navigation and shows up in the
     * route's types; the sign-up form reads it from the URL at submit time
     * rather than taking it as a prop, because the same token has to reach the
     * anonymous-conversion dialog, which is not a child of this route.
     */
    validateSearch: (search: Record<string, unknown>): { invite?: string } => {
        const invite = typeof search["invite"] === "string" ? search["invite"].trim() : "";

        return invite ? { invite } : {};
    },
    head: ({ match }) => {
        return {
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Sign Up`) }),
        };
    },
});

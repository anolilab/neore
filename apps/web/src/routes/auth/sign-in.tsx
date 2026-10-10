import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import AuthCard from "@/features/auth/components/auth/auth-card";
import { seo } from "@/lib/seo";

const RouteComponent = () => <AuthCard view="SIGN_IN" />;

export const Route = createFileRoute("/auth/sign-in")({
    component: RouteComponent,
    head: ({ match }) => {
        return {
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Sign In`) }),
        };
    },
});

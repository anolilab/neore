import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import AuthCard from "@/features/auth/components/auth/auth-card";
import { seo } from "@/lib/seo";

const RouteComponent = () => <AuthCard view="FORGOT_PASSWORD" />;

export const Route = createFileRoute("/auth/forgot-password")({
    component: RouteComponent,
    head: ({ match }) => {
        return {
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Forgot Password`) }),
        };
    },
});

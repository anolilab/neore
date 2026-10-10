import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import AuthCard from "@/features/auth/components/auth/auth-card";
import { seo } from "@/lib/seo";

/**
 * Where account deletion, a stale-session "Sign Out" and the account switcher
 * send the user (`${basePath}/${viewPaths.SIGN_OUT}`). The view ends the session
 * and reloads; without this route those navigations landed on a 404 and the
 * browser kept a session the server had already deleted.
 */
const RouteComponent = () => (
    <div className="flex min-h-[calc(100vh-10rem)] flex-col items-center justify-center p-2 md:p-6">
        <AuthCard view="SIGN_OUT" />
    </div>
);

export const Route = createFileRoute("/auth/sign-out")({
    component: RouteComponent,
    head: ({ match }) => {
        return {
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Sign Out`) }),
        };
    },
});

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import AuthCard from "@/features/auth/components/auth/auth-card";
import ConvertAnonymousAccount from "@/features/auth/components/auth/convert-anonymous-account";
import useInviteOnly from "@/features/auth/hooks/use-invite-only";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";

const ConvertAccountPage = () => {
    const { isAnonymous } = useIsAnonymous();
    const navigate = useNavigate({ from: "/auth/convert-account" });
    // Converting creates an account, so under invite-only it needs an invitation (`?invite=`).
    const { canSignUp } = useInviteOnly();

    useEffect(() => {
        // Redirect non-anonymous users away from this page
        if (!isAnonymous) {
            navigate({ to: "/" });
        }
    }, [isAnonymous, navigate]);

    if (!isAnonymous) {
        return null;
    }

    return (
        <div className="flex min-h-screen items-center justify-center p-4">
            {canSignUp ? (
                <ConvertAnonymousAccount
                    onSuccess={() => {
                        navigate({ to: "/chat", search: {} });
                    }}
                />
            ) : (
                // Says that registration is by invitation (or nothing until the backend has answered), with a sign-in link.
                <AuthCard view="SIGN_UP" />
            )}
        </div>
    );
};

export const Route = createFileRoute("/auth/convert-account")({
    component: ConvertAccountPage,
});

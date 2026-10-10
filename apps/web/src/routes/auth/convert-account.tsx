import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import ConvertAnonymousAccount from "@/features/auth/components/auth/convert-anonymous-account";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";

const ConvertAccountPage = () => {
    const { isAnonymous } = useIsAnonymous();
    const navigate = useNavigate({ from: "/auth/convert-account" });

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
            <ConvertAnonymousAccount
                onSuccess={() => {
                    navigate({ to: "/chat", search: {} });
                }}
            />
        </div>
    );
};

export const Route = createFileRoute("/auth/convert-account")({
    component: ConvertAccountPage,
});

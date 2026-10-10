import { createFileRoute } from "@tanstack/react-router";

import AuthCard from "@/features/auth/components/auth/auth-card";

const RouteComponent = () => <AuthCard view="RECOVER_ACCOUNT" />;

export const Route = createFileRoute("/auth/recover-account")({
    component: RouteComponent,
});

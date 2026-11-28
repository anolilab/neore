import { createFileRoute } from "@tanstack/react-router";

import AuthCard from "@/features/auth/components/auth/auth-card";

const RouteComponent = () => <AuthCard view="EMAIL_OTP" />;

export const Route = createFileRoute("/auth/two-factor/otp")({
    component: RouteComponent,
});

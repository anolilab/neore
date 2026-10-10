"use client";

import { createFileRoute } from "@tanstack/react-router";

import AuthCard from "@/features/auth/components/auth/auth-card";

const RouteComponent = () => <AuthCard view="ACCEPT_INVITATION" />;

export const Route = createFileRoute("/auth/accept-invitation/$invitationId/")({
    component: RouteComponent,
});

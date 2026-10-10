"use client";

import { useLingui } from "@lingui/react/macro";
import OrgSwitcher from "@neore/chat-ui/org-switcher/org-switcher";
import { useNavigate } from "@tanstack/react-router";
import type { FC } from "react";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import authViewPaths from "@/features/auth/lib/auth-view-paths";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import type { User } from "@/features/auth/types/auth-core-types";

import CreateOrganizationDialog from "./create-organization-dialog";

export interface OrganizationSwitcherProps {
    className?: string;
    hidePersonal?: boolean;
    onSetActive?: (organizationId: string | null) => void;
    size?: "default" | "icon" | "sm";
}

const OrganizationSwitcher: FC<OrganizationSwitcherProps> = ({ className, hidePersonal, onSetActive, size }) => {
    const authContext = useAuth();
    const { t } = useLingui();
    const navigate = useNavigate();

    const [isPending, setIsPending] = useState(false);
    const [isCreateOrgDialogOpen, setIsCreateOrgDialogOpen] = useState(false);

    const { data: sessionData } = authContext.hooks.useSession();
    const user = sessionData?.user;

    const { data: organizations } = authContext.hooks.useListOrganizations();
    const { data: activeOrganization, refetch: refetchActiveOrganization } = authContext.hooks.useActiveOrganization();

    const switchOrganization = useCallback(
        async (organizationId: string | null) => {
            if (hidePersonal && organizationId === null) {
                return;
            }

            setIsPending(true);

            try {
                onSetActive?.(organizationId);
                await authContext.authClient.organization.setActive({
                    fetchOptions: { throw: true },
                    organizationId,
                });
                await refetchActiveOrganization?.();
            } catch (error) {
                authContext.toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            } finally {
                setIsPending(false);
            }
        },
        [authContext, hidePersonal, onSetActive, refetchActiveOrganization, t],
    );

    // Auto-select first organization when hidePersonal is true and none is active
    useEffect(() => {
        if (hidePersonal && !activeOrganization && !isPending && organizations && organizations.length > 0) {
            switchOrganization(organizations[0]?.id ?? null);
        }
    }, [hidePersonal, activeOrganization, isPending, organizations, switchOrganization]);

    const handleOpenSettings = useCallback(() => {
        const base = authContext.settings?.basePath || authContext.basePath;
        const path = activeOrganization ? `${base}/${authViewPaths.ORGANIZATION}` : `${base}/${authViewPaths.SETTINGS}`;

        void navigate({ to: path as never });
    }, [authContext, activeOrganization, navigate]);

    return (
        <>
            <OrgSwitcher
                activeOrgId={activeOrganization?.id ?? null}
                className={className}
                currentUser={
                    user && !(user as User).isAnonymous
                        ? {
                              email: user.email,
                              image: user.image ?? undefined,
                              name: user.name ?? undefined,
                          }
                        : undefined
                }
                hidePersonal={hidePersonal}
                isPending={isPending}
                onCreateOrg={() => setIsCreateOrgDialogOpen(true)}
                onOpenSettings={handleOpenSettings}
                onSwitch={switchOrganization}
                organizations={(organizations ?? []).map((org) => {
                    return {
                        id: org.id,
                        logo: org.logo ?? undefined,
                        name: org.name,
                        slug: org.slug,
                    };
                })}
                size={size}
            />
            <CreateOrganizationDialog onOpenChange={setIsCreateOrgDialogOpen} open={isCreateOrgDialogOpen} />
        </>
    );
};

export default OrganizationSwitcher;

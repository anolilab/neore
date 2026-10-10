"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useState } from "react";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import CreateOrganizationDialog from "./create-organization-dialog";
import OrganizationCell from "./organization-cell";
import UserInvitationsCard from "./user-invitations-card";

const OrganizationsCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const isHydrated = useIsHydrated();
    const { data: organizations, isPending: organizationsPending } = useListOrganizations(authClient);

    const isPending = !isHydrated || organizationsPending;

    const [createDialogOpen, setCreateDialogOpen] = useState(false);

    return (
        <div className={cn("flex w-full flex-col gap-4 md:gap-6", className)}>
            <UserInvitationsCard classNames={classNames} />

            <SettingsCard
                action={() => {
                    setCreateDialogOpen(true);
                }}
                actionLabel={t`Create Organization`}
                classNames={classNames}
                description={t`Manage your organizations and memberships`}
                instructions={t`Create new organizations or manage existing ones`}
                isPending={isPending}
                title={t`Organizations`}
                {...properties}
            >
                {organizations && organizations?.length > 0 && (
                    <CardContent className={cn("grid gap-4", classNames?.content)}>
                        {organizations?.map((organization) => (
                            <OrganizationCell classNames={classNames} key={organization.id} organization={organization} />
                        ))}
                    </CardContent>
                )}
            </SettingsCard>

            <CreateOrganizationDialog classNames={classNames} onOpenChange={setCreateDialogOpen} open={createDialogOpen} />
        </div>
    );
};

export default OrganizationsCard;

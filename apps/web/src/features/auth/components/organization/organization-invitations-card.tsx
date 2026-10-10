"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import InvitationCell from "./invitation-cell";

const OrganizationInvitationsCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization } = useActiveOrganization(authClient);
    const invitations = activeOrganization?.invitations;

    const pendingInvitations = invitations?.filter((invitation) => invitation.status === "pending");

    if (!pendingInvitations?.length) {
        return null;
    }

    const isPending = !activeOrganization;

    return (
        <SettingsCard
            className={className}
            classNames={classNames}
            description={t`Invitations waiting for a response`}
            isPending={isPending}
            title={t`Pending Invitations`}
            {...properties}
        >
            <CardContent className={cn("grid gap-4", classNames?.content)}>
                {pendingInvitations.map((invitation) => (
                    <InvitationCell classNames={classNames} invitation={invitation} key={invitation.id} />
                ))}
            </CardContent>
        </SettingsCard>
    );
};

export default OrganizationInvitationsCard;

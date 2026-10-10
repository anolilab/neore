"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";
import { useEffect, useState } from "react";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization, useHasPermission } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { ORGANIZATIONS_SETTINGS_PATH } from "@/features/auth/lib/auth-view-paths";

import InviteMemberDialog from "./invite-member-dialog";
import MemberCell from "./member-cell";

const OrganizationMembersContent = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization } = useActiveOrganization(authClient);
    const { data: hasPermissionInvite, isPending: isPendingInvite } = useHasPermission(authClient, {
        permissions: {
            invitation: ["create"],
        },
    });

    const { data: hasPermissionUpdateMember, isPending: isPendingUpdateMember } = useHasPermission(authClient, {
        permissions: {
            member: ["update"],
        },
    });

    const isPending = isPendingInvite || isPendingUpdateMember;

    const members = activeOrganization?.members;

    const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

    const canAddMembers = hasPermissionInvite?.success;

    // Members join only by accepting an invitation, so there is no direct add.
    const addMemberButton = canAddMembers ? (
        <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={isPending} onClick={() => setInviteDialogOpen(true)}>
            {t`Send Invitation`}
        </Button>
    ) : null;

    return (
        <>
            <SettingsCard
                className={className}
                classNames={classNames}
                description={t`Manage organization members and their roles`}
                header={
                    <div className="flex items-center justify-between">
                        <span>{t`Members`}</span>
                        {addMemberButton}
                    </div>
                }
                instructions={t`Invite new members. They join once they accept the invitation.`}
                isPending={isPending}
                {...properties}
            >
                {!isPending && members && members.length > 0 && (
                    <CardContent className={cn("grid gap-4", classNames?.content)}>
                        {members
                            .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                            .map((member) => (
                                <MemberCell classNames={classNames} hideActions={!hasPermissionUpdateMember?.success} key={member.id} member={member} />
                            ))}
                    </CardContent>
                )}
            </SettingsCard>

            <InviteMemberDialog classNames={classNames} onOpenChange={setInviteDialogOpen} open={inviteDialogOpen} />
        </>
    );
};

const OrganizationMembersCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient, replace } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization, isFetching: organizationFetching, isSuccess: organizationLoaded } = useActiveOrganization(authClient);

    useEffect(() => {
        // Only a lookup that SUCCEEDED and found nothing means "no organization". A
        // failed one (a 429 from the auth rate limit, a network blip) is not an
        // answer, and redirecting on it bounced users who have one.
        if (!organizationLoaded || organizationFetching) {
            return;
        }

        // No organization to show: send the user to the list, where one is created or chosen.
        if (!activeOrganization) replace(ORGANIZATIONS_SETTINGS_PATH);
    }, [activeOrganization, organizationLoaded, organizationFetching, replace]);

    if (!activeOrganization) {
        return (
            <SettingsCard
                actionLabel={t`Invite Member`}
                className={className}
                classNames={classNames}
                description={t`Manage organization members and their roles`}
                instructions={t`Invite new members and update existing member roles`}
                isPending
                title={t`Members`}
                {...properties}
            />
        );
    }

    return <OrganizationMembersContent className={className} classNames={classNames} {...properties} />;
};

export default OrganizationMembersCard;

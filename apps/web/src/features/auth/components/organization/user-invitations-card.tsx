"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent } from "@neore/ui/components/card";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, Loader2, XIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization, useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";

/** Reads the clock, so it lives outside the components that render with it. */
const hasExpired = (expiresAt: number): boolean => expiresAt < Date.now();

interface UserInvitation {
    expiresAt: number;
    id: string;
    inviterName: string | null;
    organizationName: string;
    organizationSlug: string;
    role: string;
}

interface UserInvitationCellProperties {
    className?: string;
    invitation: UserInvitation;
    refetchInvitations?: () => void;
}

const UserInvitationCell = ({ className, invitation, refetchInvitations }: UserInvitationCellProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();

    const { refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const { refetch: refetchOrganizations } = useListOrganizations(authClient);

    const [isAccepting, setIsAccepting] = useState(false);
    const [isRejecting, setIsRejecting] = useState(false);

    const isExpired = hasExpired(invitation.expiresAt);

    const handleAccept = async () => {
        setIsAccepting(true);

        try {
            await authClient.organization.acceptInvitation({
                fetchOptions: { throw: true },
                invitationId: invitation.id,
            });

            await refetchActiveOrganization?.();
            await refetchOrganizations?.();
            refetchInvitations?.();

            toast({
                message: t`Invitation accepted`,
                variant: "success",
            });
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        } finally {
            setIsAccepting(false);
        }
    };

    const handleReject = async () => {
        setIsRejecting(true);

        try {
            await authClient.organization.rejectInvitation({
                fetchOptions: { throw: true },
                invitationId: invitation.id,
            });

            refetchInvitations?.();

            toast({
                message: t`Invitation rejected`,
                variant: "success",
            });
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        } finally {
            setIsRejecting(false);
        }
    };

    return (
        <Card className={cn("flex-row items-center gap-4 p-4", className)}>
            <div className="flex flex-1 flex-col gap-1">
                <span className="font-medium">{invitation.organizationName}</span>
                <span className="text-muted-foreground text-sm">
                    {invitation.inviterName ? t`Invited by ${invitation.inviterName}` : t`Invited to join`}
                    {invitation.role !== "member" && ` as ${invitation.role}`}
                </span>
                {isExpired && <span className="text-destructive text-xs">{t`This invitation has expired`}</span>}
            </div>

            <div className="flex gap-2">
                <Button disabled={isAccepting || isRejecting || isExpired} onClick={handleAccept} size="sm" variant="default">
                    {isAccepting ? <Loader2 className="size-4 animate-spin" /> : <CheckIcon className="size-4" />}
                    {t`Accept`}
                </Button>

                <Button disabled={isAccepting || isRejecting} onClick={handleReject} size="sm" variant="outline">
                    {isRejecting ? <Loader2 className="size-4 animate-spin" /> : <XIcon className="size-4" />}
                    {t`Reject`}
                </Button>
            </div>
        </Card>
    );
};

const UserInvitationsCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { t } = useLingui();
    const crpc = useCRPC();

    const isHydrated = useIsHydrated();
    const {
        data: invitations,
        isPending: invitationsPending,
        refetch: refetchInvitations,
    } = useQuery(crpc.auth.organization.listUserInvitations.queryOptions({}));

    const isPending = !isHydrated || invitationsPending;

    const pendingInvitations: UserInvitation[] = invitations?.filter((inv: UserInvitation) => !hasExpired(inv.expiresAt)) || [];

    return (
        <SettingsCard
            className={className}
            classNames={classNames}
            description={t`View and respond to organization invitations`}
            instructions={t`Accept or reject invitations to join organizations`}
            isPending={isPending}
            title={t`Pending Invitations`}
            {...properties}
        >
            {!isPending && pendingInvitations.length > 0 && (
                <CardContent className={cn("grid gap-4", classNames?.content)}>
                    {pendingInvitations.map((invitation) => (
                        <UserInvitationCell
                            invitation={invitation}
                            key={invitation.id}
                            refetchInvitations={() => {
                                refetchInvitations();
                            }}
                        />
                    ))}
                </CardContent>
            )}

            {!isPending && pendingInvitations.length === 0 && (
                <CardContent className={classNames?.content}>
                    <p className="text-muted-foreground text-center text-sm">{t`No pending invitations`}</p>
                </CardContent>
            )}
        </SettingsCard>
    );
};

export default UserInvitationsCard;

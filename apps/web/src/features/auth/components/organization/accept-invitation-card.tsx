"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { useParams } from "@tanstack/react-router";
import { CheckIcon, Loader2, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useInvitation } from "@/features/auth/hooks/organization-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import useAuthenticate from "../../hooks/use-authenticate";
import { getLocalizedError } from "../../lib/utilities";
import OrganizationView from "./organization-view";

const AcceptInvitationSkeleton = ({ className, classNames }: AcceptInvitationCardProperties) => (
    <Card className={cn("w-full max-w-sm", className, classNames?.base)}>
        <CardHeader className={cn("justify-items-center", classNames?.header)}>
            <Skeleton className={cn("my-1 h-5 w-full max-w-32 md:h-5.5 md:w-40", classNames?.skeleton)} />

            <Skeleton className={cn("my-0.5 h-3 w-full max-w-56 md:h-3.5 md:w-64", classNames?.skeleton)} />
        </CardHeader>

        <CardContent className={cn("flex flex-col gap-6 truncate", classNames?.content)}>
            <Card className={cn("flex-row items-center p-4")}>
                <OrganizationView isPending />

                <Skeleton className="mt-0.5 ml-auto h-4 w-full max-w-14 shrink-2" />
            </Card>

            <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-9 w-full" />

                <Skeleton className="h-9 w-full" />
            </div>
        </CardContent>
    </Card>
);

const AcceptInvitationContent = ({ className, classNames, invitationId }: AcceptInvitationCardProperties & { invitationId: string }) => {
    const { authClient, organization, redirectTo, replace, toast } = useAuth();
    const { t } = useLingui();

    const [isRejecting, setIsRejecting] = useState(false);
    const [isAccepting, setIsAccepting] = useState(false);
    const isProcessing = isRejecting || isAccepting;

    const { data: invitation, isPending } = useInvitation(authClient, {
        query: {
            id: invitationId,
        },
    });

    useEffect(() => {
        if (isPending || !invitationId) {
            return;
        }

        if (!invitation) {
            toast({
                message: t`Invitation not found`,
                variant: "error",
            });

            replace(redirectTo);

            return;
        }

        if (invitation.status !== "pending" || new Date(invitation.expiresAt) < new Date()) {
            toast({
                message: new Date(invitation.expiresAt) < new Date() ? t`Invitation expired` : t`Invitation not found`,
                variant: "error",
            });

            replace(redirectTo);
        }
    }, [invitation, isPending, invitationId, toast, replace, redirectTo, t]);

    if (isPending) return <AcceptInvitationSkeleton className={className} classNames={classNames} />;

    const acceptInvitation = async () => {
        if (!invitationId) {
            return;
        }

        setIsAccepting(true);

        try {
            await authClient.organization.acceptInvitation({
                fetchOptions: { throw: true },
                invitationId,
            });

            toast({
                message: t`Invitation accepted`,
                variant: "success",
            });

            replace(redirectTo);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
            setIsAccepting(false);
        }
    };

    const rejectInvitation = async () => {
        if (!invitationId) {
            return;
        }

        setIsRejecting(true);

        try {
            await authClient.organization.rejectInvitation({
                fetchOptions: { throw: true },
                invitationId,
            });

            toast({
                message: t`Invitation rejected`,
                variant: "success",
            });

            replace(redirectTo);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });

            setIsRejecting(false);
        }
    };

    const builtInRoles = [
        { label: t`Owner`, role: "owner" },
        { label: t`Admin`, role: "admin" },
        { label: t`Member`, role: "member" },
    ];

    const roles = [...builtInRoles, ...(organization?.customRoles || [])];

    const roleLabel = roles.find((r) => r.role === invitation?.role)?.label || invitation?.role;

    return (
        <Card className={cn("w-full max-w-sm", className, classNames?.base)}>
            <CardHeader className={cn("justify-items-center text-center", classNames?.header)}>
                <CardTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Accept Invitation`}</CardTitle>

                <CardDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                    {t`You've been invited to join an organization`}
                </CardDescription>
            </CardHeader>

            <CardContent className={cn("flex flex-col gap-6 truncate", classNames?.content)}>
                <Card className={cn("flex-row items-center p-4")}>
                    <OrganizationView
                        organization={
                            invitation
                                ? {
                                      createdAt: new Date(),
                                      id: invitation.organizationId,
                                      name: invitation.organizationName,
                                      slug: invitation.organizationSlug,
                                  }
                                : null
                        }
                    />

                    <p className="text-muted-foreground ml-auto text-sm">{roleLabel}</p>
                </Card>

                <div className="grid grid-cols-2 gap-3">
                    <Button className={cn(classNames?.button, classNames?.outlineButton)} disabled={isProcessing} onClick={rejectInvitation} variant="outline">
                        {isRejecting ? <Loader2 className="animate-spin" /> : <XIcon />}

                        {t`Reject`}
                    </Button>

                    <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={isProcessing} onClick={acceptInvitation}>
                        {isAccepting ? <Loader2 className="animate-spin" /> : <CheckIcon />}

                        {t`Accept`}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
};

export interface AcceptInvitationCardProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
}

const AcceptInvitationCard = ({ className, classNames }: AcceptInvitationCardProperties) => {
    const { authClient, redirectTo, replace, toast } = useAuth();
    const { t } = useLingui();

    const { data: sessionData } = useSession(authClient);
    // `invitationId` is a PATH param on /auth/accept-invitation/$invitationId — not a search param.
    const parameters = useParams({ strict: false });
    const invitationId = parameters.invitationId ?? null;

    useEffect(() => {
        if (invitationId) {
            return;
        }

        toast({
            message: t`Invitation not found`,
            variant: "error",
        });

        replace(redirectTo);
    }, [invitationId, toast, replace, redirectTo, t]);

    // If session is not loaded yet, use authenticate hook to check
    useAuthenticate();

    if (!sessionData || !invitationId) {
        return <AcceptInvitationSkeleton className={className} classNames={classNames} />;
    }

    return <AcceptInvitationContent className={className} classNames={classNames} invitationId={invitationId} />;
};

export default AcceptInvitationCard;

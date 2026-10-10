"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback } from "@neore/ui/components/avatar";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { formatDate } from "@neore/ui/utils/locale-format";
import type { Invitation } from "better-auth/plugins/organization";
import { EllipsisIcon, Loader2, XIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../lib/utilities";

export interface InvitationCellProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    invitation: Invitation;
}

const InvitationCell = ({ className, classNames, invitation }: InvitationCellProperties) => {
    const { authClient, organization, toast } = useAuth();
    const { i18n, t } = useLingui();

    const [isLoading, setIsLoading] = useState(false);

    const { refetch } = useActiveOrganization(authClient);

    const builtInRoles = [
        { label: t`Owner`, role: "owner" },
        { label: t`Admin`, role: "admin" },
        { label: t`Member`, role: "member" },
    ];

    const roles = [...builtInRoles, ...(organization?.customRoles || [])];
    const role = roles.find((r) => r.role === invitation.role);

    const handleCancelInvitation = async () => {
        setIsLoading(true);

        try {
            await authClient.organization.cancelInvitation({
                fetchOptions: { throw: true },
                invitationId: invitation.id,
            });

            await refetch?.();

            toast({
                message: t`Invitation cancelled`,
                variant: "success",
            });
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setIsLoading(false);
    };

    return (
        <Card className={cn("flex-row items-center p-4", className, classNames?.cell)}>
            <div className="flex flex-1 items-center gap-2">
                <Avatar className="my-0.5 h-8 w-8 rounded-lg">
                    <AvatarFallback className="rounded-lg" name={invitation.email || undefined}>
                        {invitation.email?.charAt(0)?.toUpperCase() || "U"}
                    </AvatarFallback>
                </Avatar>

                <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-semibold">{invitation.email}</span>

                    <span className="text-muted-foreground truncate text-xs">
                        {t`Expires`} {formatDate(invitation.expiresAt, i18n.locale)}
                    </span>
                </div>
            </div>

            <span className="truncate text-sm opacity-70">{role?.label}</span>

            <DropdownMenu>
                <DropdownMenuTrigger
                    render={
                        <Button
                            className={cn("relative ms-auto", classNames?.button, classNames?.outlineButton)}
                            disabled={isLoading}
                            size="icon"
                            type="button"
                            variant="outline"
                        >
                            {isLoading ? <Loader2 className="animate-spin" /> : <EllipsisIcon className={classNames?.icon} />}
                        </Button>
                    }
                />

                <DropdownMenuContent
                    onCloseAutoFocus={(e) => {
                        e.preventDefault();
                    }}
                >
                    <DropdownMenuItem disabled={isLoading} onClick={handleCancelInvitation} variant="destructive">
                        <XIcon className={classNames?.icon} />
                        {t`Cancel Invitation`}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </Card>
    );
};

export default InvitationCell;

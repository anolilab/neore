"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import type { Organization } from "better-auth/plugins/organization";
import { EllipsisIcon, Loader2, LogOutIcon, SettingsIcon } from "lucide-react";
import { useCallback, useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../lib/utilities";
import LeaveOrganizationDialog from "./leave-organization-dialog";
import OrganizationView from "./organization-view";

export interface OrganizationCellProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    organization: Organization;
}

const OrganizationCell = ({ className, classNames, organization }: OrganizationCellProperties) => {
    const { authClient, basePath, navigate, settings, toast, viewPaths } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization, refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
    const [isManagingOrganization, setIsManagingOrganization] = useState(false);

    const handleManageOrganization = useCallback(async () => {
        if (activeOrganization?.id === organization.id) {
            navigate(`${settings?.basePath || basePath}/${viewPaths.ORGANIZATION}`);

            return;
        }

        setIsManagingOrganization(true);

        try {
            await authClient.organization.setActive({
                fetchOptions: {
                    throw: true,
                },
                organizationId: organization.id,
            });

            await refetchActiveOrganization?.();

            navigate(`${settings?.basePath || basePath}/${viewPaths.ORGANIZATION}`);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setIsManagingOrganization(false);
    }, [activeOrganization, authClient, organization.id, basePath, settings, viewPaths, navigate, toast, refetchActiveOrganization, t]);

    return (
        <>
            <Card className={cn("flex-row p-4", className, classNames?.cell)}>
                <OrganizationView organization={organization} />

                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                className={cn("relative ms-auto", classNames?.button, classNames?.outlineButton)}
                                disabled={isManagingOrganization}
                                size="icon"
                                type="button"
                                variant="outline"
                            >
                                {isManagingOrganization ? <Loader2 className="animate-spin" /> : <EllipsisIcon className={classNames?.icon} />}
                            </Button>
                        }
                    />

                    <DropdownMenuContent>
                        <DropdownMenuItem disabled={isManagingOrganization} onClick={handleManageOrganization}>
                            <SettingsIcon className={classNames?.icon} />

                            {t`Manage Organization`}
                        </DropdownMenuItem>

                        <DropdownMenuItem
                            onClick={() => {
                                setIsLeaveDialogOpen(true);
                            }}
                            variant="destructive"
                        >
                            <LogOutIcon className={classNames?.icon} />

                            {t`Leave Organization`}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </Card>

            <LeaveOrganizationDialog onOpenChange={setIsLeaveDialogOpen} open={isLeaveDialogOpen} organization={organization} />
        </>
    );
};

export default OrganizationCell;

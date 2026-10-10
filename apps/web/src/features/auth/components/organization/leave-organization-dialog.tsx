"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import type { Organization } from "better-auth/plugins/organization";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization, useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../lib/utilities";
import OrganizationView from "./organization-view";

export interface LeaveOrganizationDialogProperties extends ComponentProps<typeof Dialog> {
    className?: string;
    classNames?: SettingsCardClassNames;
    organization: Organization;
}

const LeaveOrganizationDialog = ({ className, classNames, onOpenChange, organization, ...properties }: LeaveOrganizationDialogProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization, refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const { refetch: refetchOrganizations } = useListOrganizations(authClient);

    const [isLeaving, setIsLeaving] = useState(false);

    const handleLeaveOrganization = async () => {
        setIsLeaving(true);

        try {
            await authClient.organization.leave({
                fetchOptions: {
                    throw: true,
                },
                organizationId: organization.id,
            });

            toast({
                message: t`Left organization successfully`,
                variant: "success",
            });

            if (activeOrganization?.id === organization.id) {
                refetchActiveOrganization?.();
            }

            await refetchOrganizations?.();

            onOpenChange?.(false);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setIsLeaving(false);
    };

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent
                className={classNames?.dialog?.content}
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                }}
            >
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Leave Organization`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Are you sure you want to leave this organization?`}
                    </DialogDescription>
                </DialogHeader>

                <Card className={cn("my-2 flex-row p-4", className, classNames?.cell)}>
                    <OrganizationView organization={organization} />
                </Card>

                <DialogFooter className={classNames?.dialog?.footer}>
                    <Button
                        className={cn(classNames?.button, classNames?.outlineButton)}
                        disabled={isLeaving}
                        onClick={() => onOpenChange?.(false)}
                        type="button"
                        variant="outline"
                    >
                        {t`Cancel`}
                    </Button>

                    <Button
                        className={cn(classNames?.button, classNames?.destructiveButton)}
                        disabled={isLeaving}
                        onClick={handleLeaveOrganization}
                        type="button"
                        variant="destructive"
                    >
                        {isLeaving && <Loader2 className="animate-spin" />}

                        {t`Leave Organization`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default LeaveOrganizationDialog;

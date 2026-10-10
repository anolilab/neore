"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import type { User } from "better-auth";
import type { Member } from "better-auth/plugins/organization";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../lib/utilities";
import MemberCell from "./member-cell";

export interface RemoveMemberDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;
    member: Member & { user: Partial<User> };
}

const RemoveMemberDialog = ({ classNames, member, onOpenChange, ...properties }: RemoveMemberDialogProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();

    const { refetch } = useActiveOrganization(authClient);

    const [isRemoving, setIsRemoving] = useState(false);

    const removeMember = async () => {
        setIsRemoving(true);

        try {
            await authClient.organization.removeMember({
                fetchOptions: {
                    throw: true,
                },
                memberIdOrEmail: member.id,
                organizationId: member.organizationId,
            });

            toast({
                message: t`Member removed successfully`,
                variant: "success",
            });

            await refetch?.();
            onOpenChange?.(false);
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setIsRemoving(false);
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
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Remove Member`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Are you sure you want to remove this member?`}
                    </DialogDescription>
                </DialogHeader>

                <MemberCell className={classNames?.cell} hideActions member={member} />

                <DialogFooter className={classNames?.dialog?.footer}>
                    <Button
                        className={cn(classNames?.button, classNames?.outlineButton)}
                        disabled={isRemoving}
                        onClick={() => onOpenChange?.(false)}
                        type="button"
                        variant="outline"
                    >
                        {t`Cancel`}
                    </Button>

                    <Button
                        className={cn(classNames?.button, classNames?.destructiveButton)}
                        disabled={isRemoving}
                        onClick={removeMember}
                        type="button"
                        variant="destructive"
                    >
                        {isRemoving && <Loader2 className="animate-spin" />}
                        {t`Remove Member`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default RemoveMemberDialog;

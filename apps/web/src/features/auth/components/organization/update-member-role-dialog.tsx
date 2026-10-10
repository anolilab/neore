"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import cn from "@neore/ui/utils/cn";
import type { User } from "better-auth";
import type { Member } from "better-auth/plugins/organization";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../lib/utilities";
import MemberCell from "./member-cell";

export interface UpdateMemberRoleDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;
    member: Member & { user: Partial<User> };
}

const UpdateMemberRoleDialog = ({ classNames, member, onOpenChange, ...properties }: UpdateMemberRoleDialogProperties) => {
    const { authClient, organization, toast } = useAuth();
    const { t } = useLingui();

    const { refetch } = useActiveOrganization(authClient);
    const { data: sessionData } = useSession(authClient);
    const { data: activeOrganization } = useActiveOrganization(authClient);

    const [isUpdating, setIsUpdating] = useState(false);
    const [selectedRole, setSelectedRole] = useState(member.role);

    const builtInRoles = [
        { label: t`Owner`, role: "owner" },
        { label: t`Admin`, role: "admin" },
        { label: t`Member`, role: "member" },
    ];

    const roles = [...builtInRoles, ...(organization?.customRoles || [])];

    const currentUserRole = activeOrganization?.members.find((m) => m.user.id === sessionData?.user.id)?.role;

    const availableRoles = roles.filter((role) => {
        if (role.role === "owner") {
            return currentUserRole === "owner";
        }

        if (role.role === "admin") {
            return currentUserRole === "owner" || currentUserRole === "admin";
        }

        return true;
    });

    const updateMemberRole = async () => {
        if (selectedRole === member.role) {
            toast({
                message: t`Role is the same`,
                variant: "error",
            });

            return;
        }

        setIsUpdating(true);

        try {
            await authClient.organization.updateMemberRole({
                fetchOptions: {
                    throw: true,
                },
                memberId: member.id,
                organizationId: member.organizationId,
                // @ts-ignore - role is a string but the type expects specific values
                role: selectedRole,
            });

            toast({
                message: t`Member role updated`,
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

        setIsUpdating(false);
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
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Update Role`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>{t`Update the role for this member`}</DialogDescription>
                </DialogHeader>

                <div className="grid gap-6 py-4">
                    <MemberCell className={classNames?.cell} hideActions member={member} />

                    <Select onValueChange={(value) => setSelectedRole(value ?? "")} value={selectedRole}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder={t`Select role`} />
                        </SelectTrigger>

                        <SelectContent>
                            {availableRoles.map((role) => (
                                <SelectItem key={role.role} value={role.role}>
                                    {role.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <DialogFooter className={classNames?.dialog?.footer}>
                    <Button
                        className={cn(classNames?.button, classNames?.outlineButton)}
                        disabled={isUpdating}
                        onClick={() => onOpenChange?.(false)}
                        type="button"
                        variant="outline"
                    >
                        {t`Cancel`}
                    </Button>

                    <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={isUpdating} onClick={updateMemberRole} type="button">
                        {isUpdating && <Loader2 className="animate-spin" />}

                        {t`Update Role`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default UpdateMemberRoleDialog;

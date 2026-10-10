"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Loader2 } from "lucide-react";

import { showError, showSuccess } from "@/lib/toast";

import { useUpdateUserRole } from "../hooks/use-admin";

interface UpdateUserRoleDialogProps {
    currentRole: "admin" | "user";
    onOpenChange: (open: boolean) => void;
    onSuccess?: () => void;
    open: boolean;
    userId: Id<"user">;
    userName: string;
}

const UpdateUserRoleDialog = ({ currentRole, onOpenChange, onSuccess, open, userId, userName }: UpdateUserRoleDialogProps) => {
    const { t } = useLingui();

    const updateRole = useUpdateUserRole();

    const newRole = currentRole === "admin" ? "user" : "admin";
    const isPromoting = newRole === "admin";

    const handleUpdateRole = async () => {
        try {
            await updateRole.mutateAsync({
                role: newRole,
                userId,
            });

            showSuccess(isPromoting ? t`User has been promoted to admin` : t`Admin privileges have been removed`);

            onOpenChange(false);
            onSuccess?.();
        } catch (error: any) {
            showError(error.message || t`Failed to update user role`);
        }
    };

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{isPromoting ? t`Promote to Admin` : t`Remove Admin Privileges`}</DialogTitle>
                    <DialogDescription>
                        {isPromoting
                            ? t`Are you sure you want to make ${userName} an admin? They will have full access to admin features.`
                            : t`Are you sure you want to remove admin privileges from ${userName}? They will lose access to admin features.`}
                    </DialogDescription>
                </DialogHeader>

                <DialogFooter>
                    <Button disabled={updateRole.isPending} onClick={() => onOpenChange(false)} variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button disabled={updateRole.isPending} onClick={handleUpdateRole} variant={isPromoting ? "default" : "destructive"}>
                        {updateRole.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                        {isPromoting ? t`Promote to Admin` : t`Remove Admin`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default UpdateUserRoleDialog;

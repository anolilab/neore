"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Loader2, UserCheck } from "lucide-react";
import { useState } from "react";

import { authClient } from "@/lib/auth/client";
import { showError, showSuccess } from "@/lib/toast";

import { useLogImpersonationStart } from "../hooks/use-admin";

interface ImpersonateUserDialogProps {
    onOpenChange: (open: boolean) => void;
    onSuccess?: () => void;
    open: boolean;
    userId: Id<"user">;
    userName: string;
}

const ImpersonateUserDialog = ({ onOpenChange, onSuccess, open, userId, userName }: ImpersonateUserDialogProps) => {
    const { t } = useLingui();

    const [isPending, setIsPending] = useState(false);
    const logImpersonation = useLogImpersonationStart();

    const handleImpersonate = async () => {
        setIsPending(true);

        try {
            // Use Better Auth client to start impersonation
            await authClient.admin.impersonateUser({
                userId,
            });

            // Log the impersonation event
            await logImpersonation.mutateAsync({
                targetUserId: userId,
            });

            showSuccess(t`Impersonation started. Click "Stop Impersonating" in the header to return to your account.`);

            onOpenChange(false);
            onSuccess?.();

            // Reload the page to reflect the impersonated user
            globalThis.location.reload();
        } catch (error: any) {
            showError(error.message || t`Failed to start impersonation`);
        } finally {
            setIsPending(false);
        }
    };

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t`Impersonate User`}</DialogTitle>
                    <DialogDescription>
                        {t`You are about to impersonate ${userName}. You will see the application as they do and can perform actions on their behalf.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="bg-muted/50 rounded-lg p-4 text-sm">
                    <p className="font-medium">{t`Important:`}</p>
                    <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1">
                        <li>{t`All actions will be logged for security purposes`}</li>
                        <li>{t`You will need to click "Stop Impersonating" to return to your account`}</li>
                        <li>{t`The user will not be notified of the impersonation`}</li>
                    </ul>
                </div>

                <DialogFooter>
                    <Button disabled={isPending} onClick={() => onOpenChange(false)} variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button disabled={isPending} onClick={handleImpersonate}>
                        {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <UserCheck className="mr-2 size-4" />}
                        {t`Start Impersonating`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default ImpersonateUserDialog;

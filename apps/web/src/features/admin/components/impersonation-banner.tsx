"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useState } from "react";

import { authClient } from "@/lib/auth/client";
import { showError, showSuccess } from "@/lib/toast";

import { useIsImpersonating, useLogImpersonationStop } from "../hooks/use-admin";

/**
 * Banner shown when an admin is impersonating another user.
 * Displays a warning and provides a button to stop impersonating.
 */
const ImpersonationBanner = () => {
    const { t } = useLingui();

    const { data: impersonationStatus, isPending: isCheckingStatus } = useIsImpersonating();
    const logStop = useLogImpersonationStop();

    const [isStoppingImpersonation, setIsStoppingImpersonation] = useState(false);

    if (isCheckingStatus || !impersonationStatus?.isImpersonating) {
        return null;
    }

    const handleStopImpersonating = async () => {
        setIsStoppingImpersonation(true);

        try {
            // Log the stop event first (while we still have admin context)
            await logStop.mutateAsync({});

            // Use Better Auth client to stop impersonation
            await authClient.admin.stopImpersonating();

            showSuccess(t`You have returned to your admin account`);

            // Reload the page to reflect the admin user
            globalThis.location.reload();
        } catch (error: any) {
            showError(error.message || t`Failed to stop impersonation`);
        } finally {
            setIsStoppingImpersonation(false);
        }
    };

    return (
        <div className="bg-amber-500 px-4 py-2 text-sm text-amber-950">
            <div className="container mx-auto flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <AlertTriangle className="size-4" />
                    <span className="font-medium">{t`You are currently impersonating a user`}</span>
                    <span className="text-amber-800">{t`All actions are being logged.`}</span>
                </div>

                <Button
                    className="h-7 bg-amber-600 px-3 text-xs text-amber-50 hover:bg-amber-700"
                    disabled={isStoppingImpersonation}
                    onClick={handleStopImpersonating}
                    size="sm"
                    variant="secondary"
                >
                    {isStoppingImpersonation ? <Loader2 className="mr-1 size-3 animate-spin" /> : <X className="mr-1 size-3" />}
                    {t`Stop Impersonating`}
                </Button>
            </div>
        </div>
    );
};

export default ImpersonationBanner;

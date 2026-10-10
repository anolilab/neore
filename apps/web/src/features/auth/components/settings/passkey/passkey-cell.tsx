"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { FingerprintIcon, Loader2 } from "lucide-react";
import { useState } from "react";

import SessionFreshnessDialog from "@/components/settings/session-freshness-dialog";
import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useListPasskeys } from "@/features/auth/hooks/passkey-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

export interface PasskeyCellProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    passkey: { createdAt: Date; id: string };
}

const PasskeyCell = ({ className, classNames, passkey }: PasskeyCellProperties) => {
    const {
        authClient,
        freshAge,
        mutators: { deletePasskey },
        toast,
    } = useAuth();
    const { i18n, t } = useLingui();

    const { refetch } = useListPasskeys(authClient);

    const { data: sessionData } = useSession(authClient);
    const session = sessionData?.session;

    const [showFreshnessDialog, setShowFreshnessDialog] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const performDelete = async () => {
        setIsLoading(true);

        try {
            await deletePasskey({ id: passkey.id });
            refetch?.();
        } catch {
            setIsLoading(false);

            toast({
                message: t`Failed to delete passkey`,
                variant: "error",
            });
        }
    };

    const handleDeletePasskey = async () => {
        // Read the clock at click time, not at render time: a session that was
        // fresh when this row painted may not be by the time it is used.
        const isFresh = session ? Date.now() - session.createdAt.getTime() < freshAge * 1000 : false;

        // If session isn't fresh, show the freshness dialog
        if (!isFresh) {
            setShowFreshnessDialog(true);

            return;
        }

        await performDelete();
    };

    return (
        <>
            <SessionFreshnessDialog
                classNames={classNames}
                onOpenChange={setShowFreshnessDialog}
                onVerified={() => {
                    void performDelete();
                }}
                open={showFreshnessDialog}
            />

            <Card className={cn("flex-row items-center p-4", className, classNames?.cell)}>
                <div className="flex items-center gap-3">
                    <FingerprintIcon className={cn("size-4", classNames?.icon)} />
                    <span className="text-sm" suppressHydrationWarning>
                        {formatDateTime(passkey.createdAt, i18n.locale)}
                    </span>
                </div>

                <Button
                    className={cn("relative ms-auto", classNames?.button, classNames?.outlineButton)}
                    disabled={isLoading}
                    onClick={handleDeletePasskey}
                    size="sm"
                    variant="outline"
                >
                    {isLoading && <Loader2 className="animate-spin" />}
                    {t`Delete`}
                </Button>
            </Card>
        </>
    );
};

export default PasskeyCell;

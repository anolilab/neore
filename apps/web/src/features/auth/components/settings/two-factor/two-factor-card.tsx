"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import type { User } from "@/features/auth/types/auth-core-types";

import TwoFactorPasswordDialog from "./two-factor-password-dialog";

export interface TwoFactorCardProperties extends SettingsCardProperties {
    onShowBackupCodes?: () => void;
}

const TwoFactorCard = ({ onShowBackupCodes, ...properties }: TwoFactorCardProperties) => {
    const [showPasswordDialog, setShowPasswordDialog] = useState(false);
    const { authClient } = useAuth();
    const { t } = useLingui();

    const handleToggle = async () => {
        setShowPasswordDialog(true);
    };

    const handlePasswordDialogClose = () => {
        setShowPasswordDialog(false);
    };

    const { data: sessionData, isPending } = useSession(authClient);
    const isEnabled = (sessionData?.user as User)?.twoFactorEnabled;

    return (
        <>
            <SettingsCard
                {...properties}
                description={
                    isEnabled
                        ? t`Two-factor authentication is currently enabled for your account. This adds an extra layer of security.`
                        : t`Add an extra layer of security to your account by enabling two-factor authentication.`
                }
                header={
                    <div className="flex items-center gap-2">
                        {isEnabled ? <ShieldCheckIcon className="size-4 text-green-600" /> : <ShieldOffIcon className="text-muted-foreground size-4" />}
                        {t`Two-Factor Authentication`}
                        <Badge variant={isEnabled ? "default" : "secondary"}>{isEnabled ? t`Enabled` : t`Disabled`}</Badge>
                    </div>
                }
            >
                <SettingsRow
                    control={
                        <>
                            {isEnabled && onShowBackupCodes && (
                                <Button onClick={onShowBackupCodes} size="sm" variant="outline">
                                    {t`View Backup Codes`}
                                </Button>
                            )}
                            <Button disabled={isPending} onClick={handleToggle} size="sm" variant={isEnabled ? "destructive" : "default"}>
                                {isPending && (isEnabled ? t`Disabling...` : t`Enabling...`)}
                                {!isPending && (isEnabled ? t`Disable 2FA` : t`Enable 2FA`)}
                            </Button>
                        </>
                    }
                    description={
                        isEnabled
                            ? t`Make sure you have access to your authenticator app and backup codes before disabling 2FA.`
                            : t`You'll need an authenticator app like Google Authenticator or Authy to generate verification codes.`
                    }
                    title={
                        isEnabled
                            ? t`Two-factor authentication is active. You'll need your authenticator app or backup codes to sign in.`
                            : t`Enable two-factor authentication to secure your account with an additional verification step.`
                    }
                />
            </SettingsCard>

            <TwoFactorPasswordDialog
                classNames={properties.classNames}
                isTwoFactorEnabled={isEnabled ?? false}
                onOpenChange={handlePasswordDialogClose}
                open={showPasswordDialog}
            />
        </>
    );
};

export default TwoFactorCard;

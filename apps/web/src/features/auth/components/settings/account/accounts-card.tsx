"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useListDeviceSessions } from "@/features/auth/hooks/device-session-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import AccountCell from "./account-cell";

export interface AccountsCardProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
}

const AccountsCard = ({ className, classNames }: AccountsCardProperties) => {
    const { authClient, basePath, navigate, viewPaths } = useAuth();
    const { t } = useLingui();

    const { data: deviceSessions, isPending, refetch } = useListDeviceSessions(authClient);

    return (
        <SettingsCard
            action={() => {
                navigate(`${basePath}/${viewPaths.SIGN_IN}`);
            }}
            actionLabel={t`Add Account`}
            className={className}
            classNames={classNames}
            description={t`Manage your connected accounts`}
            instructions={t`View and manage all your active sessions`}
            isPending={isPending}
            title={t`Accounts`}
        >
            {(deviceSessions?.length ?? 0) > 0 && (
                <CardContent className={cn("grid gap-4", classNames?.content)}>
                    {deviceSessions?.map((deviceSession) => (
                        <AccountCell classNames={classNames} deviceSession={deviceSession} key={deviceSession.session.id} refetch={refetch} />
                    ))}
                </CardContent>
            )}
        </SettingsCard>
    );
};

export default AccountsCard;

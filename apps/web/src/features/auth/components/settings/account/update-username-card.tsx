"use client";

import { useLingui } from "@lingui/react/macro";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import UpdateFieldCard from "./update-field-card";

const UpdateUsernameCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: sessionData } = useSession(authClient);
    // `username`/`displayUsername` are contributed by better-auth's username plugin, which is
    // not registered on this app's authClient (see ../../../types/auth-core-types.ts), so they
    // are not on the inferred session user type.
    const user = sessionData?.user as Record<string, unknown> | undefined;
    const value = (user?.displayUsername ?? user?.username) as string | undefined;

    return (
        <UpdateFieldCard
            className={className}
            classNames={classNames}
            description={t`Your unique username for your account`}
            instructions={t`Choose a unique username`}
            label={t`Username`}
            name="username"
            placeholder={t`Enter your username`}
            required
            value={value}
            {...properties}
        />
    );
};

export default UpdateUsernameCard;

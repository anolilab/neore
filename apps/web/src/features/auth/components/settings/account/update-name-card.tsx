"use client";

import { useLingui } from "@lingui/react/macro";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import UpdateFieldCard from "./update-field-card";

const UpdateNameCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient, nameRequired } = useAuth();
    const { t } = useLingui();

    const { data: sessionData } = useSession(authClient);

    return (
        <UpdateFieldCard
            className={className}
            classNames={classNames}
            description={t`Your display name for your account`}
            instructions={t`Enter your full name or display name`}
            label={t`Name`}
            name="name"
            placeholder={t`Enter your name`}
            required={nameRequired}
            value={sessionData?.user.name}
            {...properties}
        />
    );
};

export default UpdateNameCard;

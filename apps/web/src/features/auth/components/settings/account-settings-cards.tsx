"use client";

import { useLingui } from "@lingui/react/macro";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import cn from "@neore/ui/utils/cn";

import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { AuthCardProps } from "../../types/ui-config-types";
import AccountsCard from "./account/accounts-card";
import DeleteAccountCard from "./account/delete-account-card";
import UpdateAvatarCard from "./account/update-avatar-card";
import UpdateFieldCard from "./account/update-field-card";
import UpdateNameCard from "./account/update-name-card";
import UpdateUsernameCard from "./account/update-username-card";
import ChangeEmailCard from "./security/change-email-card";

const AccountSettingsCards = ({ className, classNames }: AuthCardProps) => {
    const { additionalFields, authClient, avatar, changeEmail, credentials, multiSession, settings } = useAuth();
    const { t } = useLingui();

    const { data: sessionData } = useSession(authClient);

    return (
        <div className={cn("flex w-full flex-col gap-4 md:gap-6", className, classNames?.card)}>
            {settings?.fields?.includes("image") && avatar && <UpdateAvatarCard classNames={classNames} />}

            {credentials?.username && <UpdateUsernameCard classNames={classNames} />}

            {settings?.fields?.includes("name") && <UpdateNameCard classNames={classNames} />}

            {changeEmail && <ChangeEmailCard classNames={classNames} />}

            {settings?.fields?.map((field) => {
                if (field === "image") {
                    return null;
                }

                if (field === "name") {
                    return null;
                }

                const additionalField = additionalFields?.[field];

                if (!additionalField) {
                    return null;
                }

                const { description, instructions, label, placeholder, required, type, validate } = additionalField;

                // @ts-ignore Custom fields are not typed
                const defaultValue = sessionData?.user[field] as unknown;

                return (
                    <UpdateFieldCard
                        classNames={classNames}
                        description={description}
                        instructions={instructions}
                        key={field}
                        label={label}
                        name={field}
                        placeholder={placeholder}
                        required={required}
                        type={type}
                        validate={validate}
                        value={defaultValue}
                    />
                );
            })}

            {multiSession && <AccountsCard classNames={classNames} />}

            <Heading className="text-lg font-semibold">{t`Danger Zone`}</Heading>
            <HeadingSection>
                <DeleteAccountCard classNames={classNames} />
            </HeadingSection>
        </div>
    );
};

export default AccountSettingsCards;

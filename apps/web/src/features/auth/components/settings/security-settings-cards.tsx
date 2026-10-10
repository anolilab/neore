"use client";

import cn from "@neore/ui/utils/cn";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import useSignInMethods from "@/features/auth/hooks/use-sign-in-methods";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { AuthCardProps } from "../../types/ui-config-types";
import DeleteAccountCard from "./account/delete-account-card";
import PasskeysCard from "./passkey/passkeys-card";
import ProvidersCard from "./providers/providers-card";
import ChangePasswordCard from "./security/change-password-card";
import SessionsCard from "./security/sessions-card";
import TwoFactorCard from "./two-factor/two-factor-card";

const SecuritySettingsCards = ({ className, classNames }: AuthCardProps) => {
    const { credentials, deleteUser, genericOAuth, hooks, twoFactor } = useAuth();
    const { passkey, socialProviders } = useSignInMethods();
    // A guest's passkey would outlive the guest (the backend refuses to register one).
    const { isAnonymous } = useIsAnonymous();

    const { useListAccounts } = hooks;

    const { data: accounts, isPending: accountsPending, refetch: refetchAccounts } = useListAccounts();

    const credentialsLinked = accounts?.some((accumulator) => accumulator.providerId === "credential");

    return (
        <div className={cn("flex w-full flex-col gap-4 md:gap-6", className, classNames?.card)}>
            {credentials && <ChangePasswordCard accounts={accounts} classNames={classNames} isPending={accountsPending} skipHook />}

            {(socialProviders.length > 0 || Boolean(genericOAuth?.providers?.length)) && (
                <ProvidersCard accounts={accounts} classNames={classNames} isPending={accountsPending} refetch={refetchAccounts} skipHook />
            )}

            {twoFactor && credentialsLinked && <TwoFactorCard classNames={classNames} />}

            {passkey && !isAnonymous && <PasskeysCard classNames={classNames} />}

            <SessionsCard classNames={classNames} />

            {deleteUser && <DeleteAccountCard accounts={accounts} classNames={classNames} isPending={accountsPending} skipHook />}
        </div>
    );
};

export default SecuritySettingsCards;

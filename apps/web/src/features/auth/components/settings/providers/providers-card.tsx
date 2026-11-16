"use client";

import { useLingui } from "@lingui/react/macro";
import { Card, CardContent } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useListAccounts } from "@/features/auth/hooks/account-management";
import useCredentialChangeBlock from "@/features/auth/hooks/use-credential-change-block";
import useSignInMethods from "@/features/auth/hooks/use-sign-in-methods";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { Refetch } from "../../../types/hook-integration-types";
import ProviderCell from "./provider-cell";

export interface ProvidersCardProperties {
    accounts?: { id: string; providerId: string }[] | null;
    className?: string;
    classNames?: SettingsCardClassNames;
    isPending?: boolean;
    refetch?: Refetch;
    skipHook?: boolean;
}

type ProvidersCardContentProperties = Omit<ProvidersCardProperties, "skipHook">;

const ProvidersCardContent = ({ accounts, className, classNames, isPending, refetch }: ProvidersCardContentProperties) => {
    const { genericOAuth } = useAuth();
    const { findProvider, socialProviders } = useSignInMethods();
    const { t } = useLingui();
    // Linking is refused while an admin acts as this account; unlinking adds nothing and stays.
    const credentialBlock = useCredentialChangeBlock();

    return (
        <SettingsCard
            className={className}
            classNames={classNames}
            description={t`Manage your connected social accounts and third-party providers`}
            isPending={isPending}
            title={t`Connected Accounts`}
        >
            <CardContent className={cn("grid gap-4", classNames?.content)}>
                {isPending ? (
                    socialProviders.map((provider) => (
                        <Card className={cn("flex-row items-center gap-3 px-4 py-3", classNames?.cell)} key={provider}>
                            <div className="flex items-center gap-2">
                                <Skeleton className={cn("size-5 rounded-full", classNames?.skeleton)} />

                                <div>
                                    <Skeleton className={cn("h-4 w-24", classNames?.skeleton)} />
                                </div>
                            </div>

                            <Skeleton className={cn("ms-auto size-8 w-12", classNames?.skeleton)} />
                        </Card>
                    ))
                ) : (
                    <>
                        {credentialBlock.reason && <p className="text-muted-foreground text-sm">{credentialBlock.reason}</p>}

                        {socialProviders.map((provider) => {
                            const socialProvider = findProvider(provider);

                            if (!socialProvider) {
                                return null;
                            }

                            return (
                                <ProviderCell
                                    account={accounts?.find((accumulator) => accumulator.providerId === provider)}
                                    classNames={classNames}
                                    key={provider}
                                    linkDisabled={credentialBlock.blocked}
                                    provider={socialProvider}
                                    refetch={refetch}
                                />
                            );
                        })}

                        {genericOAuth?.providers?.map((provider) => (
                            <ProviderCell
                                account={accounts?.find((accumulator) => accumulator.providerId === provider.provider)}
                                classNames={classNames}
                                key={provider.provider}
                                linkDisabled={credentialBlock.blocked}
                                other
                                provider={provider}
                                refetch={refetch}
                            />
                        ))}
                    </>
                )}
            </CardContent>
        </SettingsCard>
    );
};

const ProvidersCardWithAccounts = (properties: Omit<ProvidersCardContentProperties, "accounts" | "isPending" | "refetch">) => {
    const { authClient } = useAuth();
    const { data, isPending, refetch } = useListAccounts(authClient);

    return <ProvidersCardContent {...properties} accounts={data} isPending={isPending} refetch={refetch} />;
};

const ProvidersCard = ({ skipHook, ...properties }: ProvidersCardProperties) =>
    skipHook ? <ProvidersCardContent {...properties} /> : <ProvidersCardWithAccounts {...properties} />;

export default ProvidersCard;

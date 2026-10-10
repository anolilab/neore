"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";
import { useLocation } from "@tanstack/react-router";
import type { SocialProvider } from "better-auth/social-providers";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { Provider } from "../../../lib/social-providers";
import type { Refetch } from "../../../types/hook-integration-types";

export interface ProviderCellProperties {
    account?: { id: string; providerId: string } | null;
    className?: string;
    classNames?: SettingsCardClassNames;
    other?: boolean;
    provider: Provider;
    refetch?: Refetch;
}

const ProviderCell = ({ account, className, classNames, other, provider, refetch }: ProviderCellProperties) => {
    const {
        authClient,
        basePath,
        baseURL,
        mutators: { unlinkAccount },
        toast,
        viewPaths,
    } = useAuth();
    const { t } = useLingui();
    const location = useLocation();

    const [isLoading, setIsLoading] = useState(false);

    const handleLink = async () => {
        setIsLoading(true);
        const callbackURL = `${baseURL}${basePath}/${viewPaths.CALLBACK}?redirectTo=${location.pathname}`;

        try {
            if (other) {
                await (
                    authClient as unknown as {
                        oauth2: { link: (options: { callbackURL: string; fetchOptions: { throw: boolean }; providerId: string }) => Promise<unknown> };
                    }
                ).oauth2.link({
                    callbackURL,
                    fetchOptions: { throw: true },
                    providerId: provider.provider as SocialProvider,
                });
            } else {
                await authClient.linkSocial({
                    callbackURL,
                    fetchOptions: { throw: true },
                    provider: provider.provider as SocialProvider,
                });
            }
        } catch {
            toast({
                message: t`Failed to link account`,
                variant: "error",
            });

            setIsLoading(false);
        }
    };

    const handleUnlink = async () => {
        if (!account) {
            return;
        }

        setIsLoading(true);

        try {
            // `accountId` is the account ROW id. Passing the provider's account id here
            // (what the previous `account.accountId` held) unlinks nothing in 1.7.
            await unlinkAccount({ accountId: account.id });

            await refetch?.();
        } catch {
            toast({
                message: t`Failed to unlink account`,
                variant: "error",
            });
        }

        setIsLoading(false);
    };

    return (
        <Card className={cn("flex-row items-center gap-3 px-4 py-3", className, classNames?.cell)}>
            {provider.icon && <provider.icon className={cn("size-4", classNames?.icon)} />}

            <span className="text-sm">{provider.name}</span>

            <Button
                className={cn("relative ms-auto", classNames?.button)}
                disabled={isLoading}
                onClick={account ? handleUnlink : handleLink}
                size="sm"
                type="button"
                variant={account ? "outline" : "default"}
            >
                {isLoading && <Loader2 className="animate-spin" />}
                {account ? t`Unlink` : t`Link`}
            </Button>
        </Card>
    );
};

export default ProviderCell;

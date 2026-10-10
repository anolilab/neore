"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import cn from "@neore/ui/utils/cn";
import { useState } from "react";

import SessionFreshnessDialog from "@/components/settings/session-freshness-dialog";
import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useListPasskeys } from "@/features/auth/hooks/passkey-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import PasskeyCell from "./passkey-cell";

export interface PasskeysCardProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
}

const PasskeysCard = ({ className, classNames }: PasskeysCardProperties) => {
    const { authClient, freshAge, toast } = useAuth();
    const { t } = useLingui();

    const { data: passkeys, isPending, refetch } = useListPasskeys(authClient);

    const { data: sessionData } = useSession(authClient);
    const session = sessionData?.session;
    // Evaluated on submit rather than during render: `Date.now()` in the render body
    // is impure, and freshness is only meaningful at the moment the user acts.
    const isSessionFresh = () => (session ? Date.now() - session.createdAt.getTime() < freshAge * 1000 : false);

    const [showFreshnessDialog, setShowFreshnessDialog] = useState(false);

    const performAddPasskey = async () => {
        try {
            await (
                authClient as unknown as { passkey: { addPasskey: (options: { fetchOptions: { throw: boolean } }) => Promise<unknown> } }
            ).passkey.addPasskey({
                fetchOptions: { throw: true },
            });
            await refetch?.();
        } catch {
            toast({
                message: t`Failed to add passkey`,
                variant: "error",
            });
        }
    };

    const form = useAppForm({
        defaultValues: {},
        onSubmit: async () => {
            // If session isn't fresh, show the freshness dialog
            if (!isSessionFresh()) {
                setShowFreshnessDialog(true);

                return;
            }

            await performAddPasskey();
        },
    });

    return (
        <>
            <SessionFreshnessDialog
                classNames={classNames}
                onOpenChange={setShowFreshnessDialog}
                onVerified={() => {
                    void performAddPasskey();
                }}
                open={showFreshnessDialog}
            />

            <form.AppForm>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        form.handleSubmit();
                    }}
                >
                    <SettingsCard
                        actionLabel={t`Add Passkey`}
                        className={className}
                        classNames={classNames}
                        description={t`Passkeys allow you to sign in securely using your device's biometric authentication or security key.`}
                        instructions={t`Click the button below to register a new passkey with your device.`}
                        isPending={isPending}
                        title={t`Passkeys`}
                    >
                        {passkeys && passkeys.length > 0 && (
                            <CardContent className={cn("grid gap-4", classNames?.content)}>
                                {passkeys?.map((passkey) => (
                                    <PasskeyCell classNames={classNames} key={passkey.id} passkey={passkey} />
                                ))}
                            </CardContent>
                        )}
                    </SettingsCard>
                </form>
            </form.AppForm>
        </>
    );
};

export default PasskeysCard;

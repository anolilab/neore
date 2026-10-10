"use client";

import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useListAccounts } from "@/features/auth/hooks/account-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import DeleteAccountDialog from "./delete-account-dialog";

export interface DeleteAccountCardProperties {
    accounts?: { providerId: string }[] | null;
    className?: string;
    classNames?: SettingsCardClassNames;
    isPending?: boolean;

    skipHook?: boolean;
}

/**
 * Renders the card against a caller-supplied account list.
 *
 * Split out from `DeleteAccountCard` so the `useListAccounts()` subscription can
 * live in its own component: calling it behind `if (!skipHook)` changed the hook
 * order between renders.
 */
const DeleteAccountCardView = ({ className, classNames, isPending }: Omit<DeleteAccountCardProperties, "skipHook">) => {
    const { t } = useLingui();

    const crpc = useCRPC();

    const [showDialog, setShowDialog] = useState(false);

    // Deletion runs as the GDPR workflow, which starts erasing as soon as it is
    // requested — there is no grace period to cancel within. While it runs the
    // account still signs in, so say so instead of offering a second request.
    const { data: gdprStatus } = useQuery(crpc.gdpr.functions.getGdprStatus.queryOptions({}));
    const deletionStatus = gdprStatus?.deletion?.status;
    const isDeletionInProgress = deletionStatus === "pending" || deletionStatus === "processing";

    return (
        <div>
            <SettingsCard
                action={() => {
                    setShowDialog(true);
                }}
                actionLabel={t`Delete Account`}
                className={className}
                classNames={classNames}
                description={
                    isDeletionInProgress
                        ? t`Your account and all associated data are being deleted. This cannot be cancelled.`
                        : t`Permanently delete your account and all associated data`
                }
                disabled={isDeletionInProgress}
                instructions={deletionStatus === "failed" ? t`The last deletion request failed. You can request it again.` : undefined}
                isPending={isPending}
                title={t`Delete Account`}
                variant="destructive"
            />

            <DeleteAccountDialog classNames={classNames} onOpenChange={setShowDialog} open={showDialog} />
        </div>
    );
};

const DeleteAccountCardWithAccounts = (properties: Omit<DeleteAccountCardProperties, "accounts" | "isPending" | "skipHook">) => {
    const { authClient } = useAuth();

    const { data: accounts, isPending } = useListAccounts(authClient);

    return <DeleteAccountCardView {...properties} accounts={accounts} isPending={isPending} />;
};

const DeleteAccountCard = ({ accounts, className, classNames, isPending, skipHook }: DeleteAccountCardProperties) =>
    skipHook ? (
        <DeleteAccountCardView accounts={accounts} className={className} classNames={classNames} isPending={isPending} />
    ) : (
        <DeleteAccountCardWithAccounts className={className} classNames={classNames} />
    );

export default DeleteAccountCard;

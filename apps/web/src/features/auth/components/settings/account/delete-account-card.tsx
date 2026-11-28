"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
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
    const { data: gdprStatus, isPending: isStatusPending } = useQuery(crpc.gdpr.functions.getGdprStatus.queryOptions({}));
    const deletionStatus = gdprStatus?.deletion?.status;
    const isDeletionInProgress = deletionStatus === "pending" || deletionStatus === "processing";

    return (
        <div>
            <SettingsCard className={className} classNames={classNames} isPending={isPending} variant="destructive">
                <SettingsRow
                    control={
                        <Button
                            className={cn(classNames?.button, classNames?.destructiveButton)}
                            // Not before the card and the deletion status have loaded: one may already be running.
                            disabled={isPending || isStatusPending || isDeletionInProgress}
                            onClick={() => {
                                setShowDialog(true);
                            }}
                            size="sm"
                            variant="destructive"
                        >
                            {t`Delete Account`}
                        </Button>
                    }
                    description={
                        <>
                            {isDeletionInProgress
                                ? t`Your account and all associated data are being deleted. This cannot be cancelled.`
                                : t`Permanently delete your account and all associated data`}
                            {deletionStatus === "failed" && (
                                <span className="mt-1 block">{t`The last deletion request failed. You can request it again.`}</span>
                            )}
                        </>
                    }
                    title={t`Delete Account`}
                />
            </SettingsCard>

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

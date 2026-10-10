"use client";

import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization } from "@/features/auth/hooks/organization-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import DeleteOrganizationDialog from "./delete-organization-dialog";

const DeleteOrganizationCard = ({ className, classNames }: SettingsCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();
    const [showDialog, setShowDialog] = useState(false);

    const { data: activeOrganization, isPending: organizationPending } = useActiveOrganization(authClient);
    const { data: sessionData, isPending: sessionPending } = useSession(authClient);

    const isPending = organizationPending || sessionPending;

    const membership = activeOrganization?.members?.find((member) => member.userId === sessionData?.user.id);
    const isOwner = membership?.role === "owner";

    if (!isPending && !isOwner) {
        return null;
    }

    return (
        <>
            <SettingsCard
                action={() => {
                    setShowDialog(true);
                }}
                actionLabel={t`Delete Organization`}
                className={className}
                classNames={classNames}
                description={t`Permanently delete this organization and all its data`}
                isPending={isPending}
                title={t`Delete Organization`}
                variant="destructive"
            />

            <DeleteOrganizationDialog classNames={classNames} onOpenChange={setShowDialog} open={showDialog} />
        </>
    );
};

export default DeleteOrganizationCard;

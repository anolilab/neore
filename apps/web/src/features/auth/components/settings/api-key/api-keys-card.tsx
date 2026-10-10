"use client";

import { useLingui } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useMemo, useState } from "react";

import SettingsCard from "@/components/settings/settings-card";
import { useListApiKeys } from "@/features/auth/hooks/api-key-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import APIKeyCell from "./api-key-cell";
import APIKeyDisplayDialog from "./api-key-display-dialog";
import CreateAPIKeyDialog from "./create-api-key-dialog";

export type APIKeysCardProperties = ComponentProps<typeof SettingsCard>;

const APIKeysCard = ({ ...properties }: APIKeysCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data } = useListApiKeys(authClient);
    const apiKeys = data?.apiKeys;

    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [displayAPIKey, setDisplayAPIKey] = useState<string | null>(null);

    const sortedAPIKeys = useMemo(() => {
        if (!apiKeys) {
            return [];
        }

        return apiKeys.toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [apiKeys]);

    return (
        <>
            <SettingsCard
                {...properties}
                action={() => {
                    setShowCreateDialog(true);
                }}
                actionLabel={
                    <>
                        <PlusIcon />
                        {t`Create API Key`}
                    </>
                }
                description={t`Create and manage API keys for programmatic access to your account.`}
                header={t`API Keys`}
            >
                {sortedAPIKeys.length > 0 ? (
                    <div className="space-y-2">
                        {sortedAPIKeys.map((apiKey) => (
                            <APIKeyCell apiKey={apiKey} key={apiKey.id} />
                        ))}
                    </div>
                ) : (
                    <div className="text-muted-foreground py-8 text-center text-sm">{t`No API keys found. Create one to get started.`}</div>
                )}
            </SettingsCard>

            <CreateAPIKeyDialog
                onOpenChange={setShowCreateDialog}
                onSuccess={(apiKey) => {
                    setDisplayAPIKey(apiKey);
                    setShowCreateDialog(false);
                }}
                open={showCreateDialog}
            />

            <APIKeyDisplayDialog apiKey={displayAPIKey || ""} onOpenChange={(open) => !open && setDisplayAPIKey(null)} open={Boolean(displayAPIKey)} />
        </>
    );
};

export default APIKeysCard;

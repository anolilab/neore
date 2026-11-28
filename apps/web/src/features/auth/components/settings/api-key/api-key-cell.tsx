"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { DEFAULT_LOCALE } from "@/lib/intl/client";

import type { ApiKey } from "../../../types/data-structure-types";
import type { Refetch } from "../../../types/hook-integration-types";
import ApiKeyDeleteDialog from "./api-key-delete-dialog";

export interface APIKeyCellProperties {
    apiKey: ApiKey;
    className?: string;
    classNames?: SettingsCardClassNames;

    refetch?: Refetch;
}

const APIKeyCell = ({ apiKey, className, classNames, refetch }: APIKeyCellProperties) => {
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const { i18n, t } = useLingui();

    // Format expiration date or show "Never expires"
    const formatExpiration = () => {
        if (!apiKey.expiresAt) {
            return t`Never expires`;
        }

        const date = new Date(apiKey.expiresAt).toLocaleDateString(i18n.locale ?? DEFAULT_LOCALE, {
            day: "numeric",
            month: "short",
            year: "numeric",
        });

        return t`Expires ${date}`;
    };

    const formatLastUsed = () => {
        if (!apiKey.lastRequest) {
            return t`Never used`;
        }

        const date = new Date(apiKey.lastRequest).toLocaleString(i18n.locale ?? DEFAULT_LOCALE, {
            dateStyle: "medium",
            timeStyle: "short",
        });

        return t`Last used ${date}`;
    };

    // `threads:read, chat:write` — what this key may do on the public API.
    const formatScopes = () => {
        const scopes = Object.entries(apiKey.permissions ?? {}).flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`));

        return scopes.length > 0 ? scopes.join(", ") : t`No API permissions`;
    };

    return (
        <>
            <Card className={cn("surface-row-card rounded-none flex-row items-center gap-3 truncate px-0 py-3", className, classNames?.cell)}>
                <span aria-hidden="true" className="surface-well grid size-[30px] shrink-0 place-items-center rounded-lg">
                    <KeyRoundIcon className={cn("text-muted-foreground size-4", classNames?.icon)} />
                </span>

                <div className="flex flex-col truncate">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{apiKey.name}</span>

                        <span className="text-muted-foreground flex-1 truncate text-xs">
                            {apiKey.start}
                            ******
                        </span>
                    </div>

                    <div className="text-muted-foreground truncate text-xs">
                        {formatExpiration()} · {formatLastUsed()}
                    </div>

                    <div className="text-muted-foreground truncate text-xs">{formatScopes()}</div>
                </div>

                <Button
                    className={cn("relative ms-auto", classNames?.button, classNames?.outlineButton)}
                    onClick={() => {
                        setShowDeleteDialog(true);
                    }}
                    size="sm"
                    variant="outline"
                >
                    {t`Delete`}
                </Button>
            </Card>

            <ApiKeyDeleteDialog apiKey={apiKey} classNames={classNames} onOpenChange={setShowDeleteDialog} open={showDeleteDialog} refetch={refetch} />
        </>
    );
};

export default APIKeyCell;

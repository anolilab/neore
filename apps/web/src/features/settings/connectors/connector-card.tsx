"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { BookOpen, CircleAlert, CircleCheck, Clock, ExternalLink, GitBranch, HardDrive, Loader2, Mail, MessageSquare, Plug } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import SettingsRow from "@/components/settings/settings-row";

import { TrustServerSwitch } from "../components/chat/trust-server-switch";
import connectorCategoryLabel from "./connector-category";
import type { ConnectorDisplayStatus } from "./connector-status";
import { connectorDisplayStatus } from "./connector-status";
import useConnectorActions from "./hooks/use-connector-actions";

/**
 * Icons by the definition's `icon` key. A static map rather than
 * `import * as LucideIcons`, which pulls every icon into the bundle.
 */
const ICONS: Record<string, FC<{ "aria-hidden"?: boolean; className?: string }>> = {
    github: GitBranch,
    gmail: Mail,
    "google-drive": HardDrive,
    notion: BookOpen,
    slack: MessageSquare,
};

export interface ConnectorConnection {
    accountLabel?: string;
    hasRefreshToken: boolean;
    id: string;
    lastError?: string;
    scopes: string[];
    status: "connected" | "disconnected" | "error" | "expired";
    tokenExpiresAt?: number;
}

export interface ConnectorCatalogEntry {
    availabilityNote?: string;
    category: string;
    configured: boolean;
    connection: ConnectorConnection | null;
    description: string;
    docsUrl?: string;
    icon?: string;
    isPremium: boolean;
    name: string;
    requestedScopes: string[];
    requiresOAuth: boolean;
    slug: string;
    status: "active" | "beta" | "deprecated";
}

/** States in which the user holds (or held) a grant, as opposed to having never connected. */
const GRANTED_STATUSES: ReadonlySet<ConnectorDisplayStatus> = new Set(["connected", "error", "expired"]);

const ConnectorCard: FC<{ entry: ConnectorCatalogEntry }> = ({ entry }) => {
    const { i18n, t } = useLingui();
    const { disconnect, initiateOAuth, isDisconnecting, startingSlug } = useConnectorActions();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [now] = useState(Date.now);
    const scopesId = useId();

    const status = connectorDisplayStatus(entry, now);
    const Icon = (entry.icon && ICONS[entry.icon]) || Plug;
    const isStarting = startingSlug === entry.slug;
    const { connection } = entry;
    const hasGrant = GRANTED_STATUSES.has(status);
    const scopes = hasGrant ? (connection?.scopes ?? []) : entry.requestedScopes;

    const statusBadge = {
        connected: { icon: CircleCheck, label: t`Connected`, variant: "default" as const },
        error: { icon: CircleAlert, label: t`Error`, variant: "destructive" as const },
        expired: { icon: Clock, label: t`Expired`, variant: "destructive" as const },
        not_configured: { icon: CircleAlert, label: t`Not configured`, variant: "outline" as const },
        not_connected: null,
    }[status];

    const handleDisconnect = async () => {
        if (!connection) {
            return;
        }

        await disconnect(connection.id);
        setConfirmOpen(false);
    };

    const hasDetails =
        (status === "connected" && Boolean(connection?.accountLabel)) ||
        status === "expired" ||
        status === "error" ||
        status === "not_configured" ||
        Boolean(entry.availabilityNote) ||
        scopes.length > 0 ||
        status === "connected" ||
        Boolean(entry.docsUrl);

    return (
        <>
            <SettingsRow
                control={
                    <>
                        {statusBadge && (
                            <Badge className="shrink-0 gap-1 text-xs" variant={statusBadge.variant}>
                                <statusBadge.icon aria-hidden className="size-3" />
                                {statusBadge.label}
                            </Badge>
                        )}

                        {(status === "not_connected" || (hasGrant && status !== "connected")) && (
                            <Button
                                aria-busy={isStarting}
                                disabled={isStarting || !entry.configured}
                                onClick={() => {
                                    initiateOAuth(entry.slug).catch(() => undefined);
                                }}
                                size="sm"
                                variant={status === "not_connected" ? "default" : "secondary"}
                            >
                                {isStarting && <Loader2 aria-hidden className="size-4 animate-spin" />}
                                {status === "not_connected" ? t`Connect ${entry.name}` : t`Reconnect ${entry.name}`}
                            </Button>
                        )}

                        {status === "not_configured" && (
                            <Button disabled size="sm" variant="outline">
                                {t`Not configured`}
                            </Button>
                        )}

                        {connection && status !== "not_connected" && status !== "not_configured" && (
                            <Button
                                aria-label={t`Disconnect ${entry.name}`}
                                disabled={isDisconnecting}
                                onClick={() => setConfirmOpen(true)}
                                size="sm"
                                variant="outline"
                            >
                                {t`Disconnect`}
                            </Button>
                        )}
                    </>
                }
                description={entry.description}
                title={
                    <span className="flex flex-wrap items-center gap-2">
                        <Icon aria-hidden className="text-primary-text size-4 shrink-0" />
                        <span>{entry.name}</span>
                        <Badge className="text-xs capitalize" variant="outline">
                            {connectorCategoryLabel(entry.category, i18n)}
                        </Badge>
                        {entry.status === "beta" && (
                            <Badge className="text-xs" variant="secondary">
                                {t`Beta`}
                            </Badge>
                        )}
                        {entry.isPremium && (
                            <Badge className="text-xs" variant="default">
                                {t`Premium`}
                            </Badge>
                        )}
                    </span>
                }
            >
                {hasDetails && (
                    <div className="flex flex-col gap-3">
                        {status === "connected" && connection?.accountLabel && (
                            <p className="text-muted-foreground text-xs">{t`Connected to ${connection.accountLabel}`}</p>
                        )}

                        {(status === "expired" || status === "error") && (
                            <p className="text-destructive text-xs">{connection?.lastError ?? t`This connection needs to be renewed.`}</p>
                        )}

                        {status === "not_configured" && (
                            <p className="text-muted-foreground text-xs">{t`An administrator needs to register an OAuth app for this connector before it can be used.`}</p>
                        )}

                        {entry.availabilityNote && <p className="text-muted-foreground text-xs">{entry.availabilityNote}</p>}

                        {scopes.length > 0 && (
                            <div>
                                <p className="text-muted-foreground text-xs font-medium" id={scopesId}>
                                    {hasGrant ? t`Granted permissions` : t`Requested permissions`}
                                </p>
                                <ul aria-labelledby={scopesId} className="mt-1 flex flex-wrap gap-1">
                                    {scopes.map((scope) => (
                                        <li key={scope}>
                                            <code className="bg-muted rounded px-1.5 py-0.5 text-[11px] break-all">
                                                {scope.replace("https://www.googleapis.com/auth/", "")}
                                            </code>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {status === "connected" && <TrustServerSwitch server={{ kind: "connector", name: entry.name, slug: entry.slug }} />}

                        {entry.docsUrl && (
                            <a
                                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                                href={entry.docsUrl}
                                rel="noopener noreferrer"
                                target="_blank"
                            >
                                {t`About ${entry.name}`}
                                <ExternalLink aria-hidden className="size-3" />
                                <span className="sr-only">{t`(opens in a new tab)`}</span>
                            </a>
                        )}
                    </div>
                )}
            </SettingsRow>

            <ConfirmDialog
                confirmLabel={t`Disconnect`}
                description={t`The AI will lose access to ${entry.name}, and the access token is revoked at the provider where possible.`}
                loading={isDisconnecting}
                onConfirm={() => {
                    handleDisconnect().catch(() => undefined);
                }}
                onOpenChange={setConfirmOpen}
                open={confirmOpen}
                title={t`Disconnect ${entry.name}?`}
            />
        </>
    );
};

export default ConnectorCard;

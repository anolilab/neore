"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { formatDate, formatTime } from "@neore/ui/utils/locale-format";
import { CheckCircle2, Copy, KeyRound, Loader2, MessageSquare, Pause, Play, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import env from "@/lib/env";

import {
    useCreateMessengerConnection,
    useDeleteMessengerConnection,
    useRegeneratePairingCode,
    useUpdateMessengerConnectionStatus,
} from "./hooks/use-messenger-connections";
import MessengerReplyTools from "./messenger-reply-tools";
import MessengerSetupDialog, { webhookHint } from "./messenger-setup-dialog";

export type MessengerPlatformId = "discord" | "feishu" | "line" | "slack" | "teams" | "telegram" | "wechat" | "whatsapp";

interface MessengerPlatformCardProps {
    /** Shows a "Beta" badge — the adapter is implemented and tested but not proven against a live account. */
    beta?: boolean;
    connection?: {
        _id: string;
        connectedAt: number;
        displayName?: string | null;
        lastMessageAt?: number | null;
        /** A contact paired with `/pair <code>`; only that contact is answered. */
        paired?: boolean;
        pairingCodeExpiresAt?: number | null;
        platformUsername?: string | null;
        /** Tools for replies — off unless the owner turns them on. */
        replyTools?: { enabled: boolean; groups: string[] };
        status: string;
    };
    description: string;
    icon: FC<{ className?: string }>;
    iconColor: string;
    name: string;
    platform: MessengerPlatformId;
}

const MessengerPlatformCard: FC<MessengerPlatformCardProps> = ({ beta, connection, description, icon: Icon, iconColor, name, platform }) => {
    const { i18n, t } = useLingui();
    const [showSetup, setShowSetup] = useState(false);
    const createConnection = useCreateMessengerConnection();
    const updateStatus = useUpdateMessengerConnectionStatus();
    const deleteConnection = useDeleteMessengerConnection();
    const regeneratePairingCode = useRegeneratePairingCode();
    // The code is shown once — only its hash is stored — so it lives in state
    // until the card unmounts or a new one replaces it.
    const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);

    const isConnected = connection?.status === "active";
    const isPaused = connection?.status === "paused";
    const hasConnection = !!connection;

    // Build the per-connection webhook URL
    const webhookUrl = connection ? `${env.VITE_LUNORA_URL}/messenger/${platform}/${connection._id}` : null;

    const handleConnect = async () => {
        try {
            const created = await createConnection.mutateAsync({ platform });

            if (created.pairingCode && created.pairingCodeExpiresAt) {
                setPairing({ code: created.pairingCode, expiresAt: created.pairingCodeExpiresAt });
            }

            toast.success(t`${name} connection activated`);
            setShowSetup(false);
        } catch (error: any) {
            toast.error(error.message || t`Failed to connect ${name}`);
        }
    };

    const handlePause = async () => {
        if (!connection) {
            return;
        }

        try {
            await updateStatus.mutateAsync({
                connectionId: connection._id,
                status: isPaused ? "active" : "paused",
            });
            toast.success(isPaused ? t`${name} resumed` : t`${name} paused`);
        } catch (error: any) {
            toast.error(error.message || t`Failed to update connection`);
        }
    };

    const handleDisconnect = async () => {
        if (!connection) {
            return;
        }

        try {
            await deleteConnection.mutateAsync({ connectionId: connection._id });
            toast.success(t`${name} disconnected`);
        } catch (error: any) {
            toast.error(error.message || t`Failed to disconnect`);
        }
    };

    const handleRegenerateCode = async () => {
        if (!connection) {
            return;
        }

        try {
            const result = await regeneratePairingCode.mutateAsync({ connectionId: connection._id as never });

            setPairing({ code: result.pairingCode, expiresAt: result.pairingCodeExpiresAt });
        } catch (error: any) {
            toast.error(error.message || t`Failed to create a pairing code`);
        }
    };

    const handleCopyWebhookUrl = async () => {
        if (!webhookUrl) {
            return;
        }

        try {
            await navigator.clipboard.writeText(webhookUrl);
            toast.success(t`Webhook URL copied to clipboard`);
        } catch {
            toast.error(t`Failed to copy URL`);
        }
    };

    const isAnyPending = createConnection.isPending || updateStatus.isPending || deleteConnection.isPending || regeneratePairingCode.isPending;
    const isPaired = connection?.paired === true;
    const platformUsername = connection?.platformUsername;
    const lastMessageAt = connection?.lastMessageAt ? formatDate(connection.lastMessageAt, i18n.locale) : null;
    const pairingValidUntil = pairing ? formatTime(pairing.expiresAt, i18n.locale) : null;

    return (
        <>
            <Card className="relative overflow-hidden transition-shadow hover:shadow-md">
                <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`flex size-10 items-center justify-center rounded-lg ${iconColor}`}>
                                <Icon aria-hidden="true" className="size-5 text-white" />
                            </div>
                            <div>
                                <CardTitle className="text-base">{name}</CardTitle>
                                <div className="mt-1 flex items-center gap-2">
                                    <Badge className="text-xs" variant="outline">
                                        {t`messenger`}
                                    </Badge>
                                    {beta && (
                                        <Badge className="text-xs" variant="secondary">
                                            {t`Beta`}
                                        </Badge>
                                    )}
                                    {isPaused && (
                                        <Badge className="text-xs" variant="secondary">
                                            {t`Paused`}
                                        </Badge>
                                    )}
                                </div>
                            </div>
                        </div>
                        {isConnected && <CheckCircle2 aria-label={t`Connected`} className="size-5 shrink-0 text-green-500" role="img" />}
                    </div>
                </CardHeader>
                <CardContent className="space-y-3">
                    <CardDescription className="text-sm">{description}</CardDescription>

                    {/* Connection info */}
                    {hasConnection && (
                        <div className="text-muted-foreground space-y-1 text-xs">
                            {platformUsername && <p>{t`Username: @${platformUsername}`}</p>}
                            {lastMessageAt && <p suppressHydrationWarning>{t`Last message: ${lastMessageAt}`}</p>}
                        </div>
                    )}

                    {/* Pairing: the bot answers only the contact who sent the one-time code */}
                    {hasConnection && (
                        <div aria-labelledby={`pairing-${platform}`} className="space-y-1" role="group">
                            <p className="text-muted-foreground text-xs font-medium" id={`pairing-${platform}`}>
                                {isPaired ? t`Paired` : t`Not paired — the bot answers nobody yet`}
                            </p>
                            {pairing && (
                                <p aria-live="polite" className="text-xs" role="status">
                                    {t`Send this to the bot from your account:`}{" "}
                                    <code className="bg-muted rounded px-1.5 py-0.5 font-mono">/pair {pairing.code}</code>{" "}
                                    <span className="text-muted-foreground" suppressHydrationWarning>
                                        {t`(valid until ${pairingValidUntil})`}
                                    </span>
                                </p>
                            )}
                            <Button className="h-7 px-2 text-xs" disabled={isAnyPending} onClick={handleRegenerateCode} size="sm" variant="outline">
                                <KeyRound aria-hidden="true" className="mr-1 size-3.5" />
                                {isPaired ? t`Re-pair with a new code` : t`New pairing code`}
                            </Button>
                        </div>
                    )}

                    {/* Tools for replies: opt-in per connection */}
                    {hasConnection && connection.replyTools && (
                        <MessengerReplyTools connectionId={connection._id} disabled={isAnyPending} replyTools={connection.replyTools} />
                    )}

                    {/* Webhook URL */}
                    {hasConnection && webhookUrl && (
                        <div className="space-y-1">
                            <p className="text-muted-foreground text-xs font-medium">{t`Webhook URL`}</p>
                            <div className="flex items-center gap-1">
                                <code className="bg-muted flex-1 truncate rounded px-2 py-1 font-mono text-xs">{webhookUrl}</code>
                                <Button aria-label={t`Copy webhook URL`} className="shrink-0" onClick={handleCopyWebhookUrl} size="icon" variant="ghost">
                                    <Copy aria-hidden="true" className="size-3.5" />
                                </Button>
                            </div>
                            <p className="text-muted-foreground text-xs">{i18n._(webhookHint(platform))}</p>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2">
                        {hasConnection ? (
                            <>
                                <Button className="flex-1" disabled={isAnyPending} onClick={handlePause} variant="outline">
                                    {isPaused ? <Play aria-hidden="true" className="mr-1 size-3.5" /> : <Pause aria-hidden="true" className="mr-1 size-3.5" />}
                                    {isPaused ? t`Resume` : t`Pause`}
                                </Button>
                                <Button aria-label={t`Disconnect ${name}`} disabled={isAnyPending} onClick={handleDisconnect} size="icon" variant="destructive">
                                    {deleteConnection.isPending ? (
                                        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                                    ) : (
                                        <Trash2 aria-hidden="true" className="size-4" />
                                    )}
                                </Button>
                            </>
                        ) : (
                            <Button className="w-full" disabled={isAnyPending} onClick={() => setShowSetup(true)}>
                                {isAnyPending ? (
                                    <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
                                ) : (
                                    <MessageSquare aria-hidden="true" className="mr-2 size-4" />
                                )}
                                {t`Connect`}
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            <MessengerSetupDialog
                isOpen={showSetup}
                isPending={createConnection.isPending}
                onClose={() => setShowSetup(false)}
                onConfirm={handleConnect}
                platform={platform}
            />
        </>
    );
};

export default MessengerPlatformCard;

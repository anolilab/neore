import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";
import type { NativeDevicePlatform, NativeDeviceStatus } from "@/lib/native/bridge";
import { getNativeDeviceStatus, openNativeDeviceSettings, pairNativeDevice } from "@/lib/native/bridge";

import { DEVICE_PAIRED_EVENT } from "../lib/device-events";
import { isDeviceOnline } from "../lib/device-relay";

interface DeviceView {
    _id: string;
    createdAt: number;
    lastSeenAt?: number;
    name: string;
    platform: NativeDevicePlatform;
    toolNames: string[];
}

/** Re-render once a minute so "online" follows the heartbeat without a refetch. */
const useNow = (): number => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);

        return () => clearInterval(timer);
    }, []);

    return now;
};

const DeviceRow: FC<{ device: DeviceView; isThisComputer: boolean; now: number }> = ({ device, isThisComputer, now }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const [name, setName] = useState(device.name);
    const [confirming, setConfirming] = useState(false);
    const rename = useMutation(crpc.devices.functions.renameDevice.mutationOptions());
    const revoke = useMutation(crpc.devices.functions.revokeDevice.mutationOptions());
    const online = isDeviceOnline(device.lastSeenAt, now);
    const nameId = `device-name-${device._id}`;

    return (
        <li className="flex flex-wrap items-center gap-3 border-b py-3 last:border-b-0">
            <div className="min-w-0 flex-1 space-y-1">
                <Label className="sr-only" htmlFor={nameId}>{t`Device name`}</Label>
                <Input
                    className="max-w-xs"
                    id={nameId}
                    maxLength={80}
                    onBlur={() => {
                        const next = name.trim();

                        if (next && next !== device.name) {
                            rename.mutate(
                                { deviceId: device._id as Id<"devices">, name: next },
                                { onError: () => toast.error(t`Could not rename the device.`) },
                            );
                        }
                    }}
                    onChange={(event) => setName(event.target.value)}
                    value={name}
                />
                <p className="text-muted-foreground text-xs">
                    {device.toolNames.length > 0 ? t`${device.toolNames.length} tools: ${device.toolNames.join(", ")}` : t`No tools shared yet`}
                </p>
            </div>
            <div className="flex items-center gap-2">
                {isThisComputer && <Badge variant="outline">{t`This computer`}</Badge>}
                <Badge variant={online ? "default" : "secondary"}>{online ? t`Online` : t`Offline`}</Badge>
                <Button onClick={() => setConfirming(true)} size="sm" variant="outline">
                    {t`Remove`}
                </Button>
            </div>
            <ConfirmDialog
                confirmLabel={t`Remove`}
                description={t`The agent can no longer ask this device for anything. Its activity log stays until it expires.`}
                loading={revoke.isPending}
                onConfirm={() => {
                    revoke.mutate(
                        { deviceId: device._id as Id<"devices"> },
                        {
                            onError: () => toast.error(t`Could not remove the device.`),
                            onSuccess: () => {
                                setConfirming(false);
                                toast.success(t`Device removed`);
                            },
                        },
                    );
                }}
                onOpenChange={setConfirming}
                open={confirming}
                title={t`Remove “${device.name}”?`}
            />
        </li>
    );
};

const STATUS_VARIANT: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
    claimed: "outline",
    completed: "default",
    denied: "secondary",
    expired: "secondary",
    failed: "destructive",
    pending: "outline",
};

const DeviceActivity: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { data: calls } = useQuery(crpc.devices.functions.listDeviceCalls.queryOptions({ limit: 30 }));

    if (!calls || calls.length === 0) {
        return <p className="text-muted-foreground text-sm">{t`Nothing has run on a device yet.`}</p>;
    }

    const statusLabel: Record<string, string> = {
        claimed: t`Waiting for approval`,
        completed: t`Done`,
        denied: t`Denied`,
        expired: t`Expired`,
        failed: t`Failed`,
        pending: t`Sent`,
    };

    return (
        <ul className="space-y-2">
            {calls.map((call) => (
                <li className="rounded-md border p-2 text-sm" key={call._id}>
                    <details>
                        <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                            <span className="font-mono">{call.toolName}</span>
                            <span className="text-muted-foreground">{call.deviceName}</span>
                            <Badge variant={STATUS_VARIANT[call.status] ?? "outline"}>{statusLabel[call.status] ?? call.status}</Badge>
                            {call.taintedBy.length > 0 && <Badge variant="outline">{t`After outside content`}</Badge>}
                            <time className="text-muted-foreground ml-auto text-xs" dateTime={new Date(call.createdAt).toISOString()}>
                                {formatDateTime(call.createdAt, i18n.locale)}
                            </time>
                        </summary>
                        <div className="mt-2 space-y-2">
                            <pre className="bg-muted max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{call.input}</pre>
                            {call.output !== undefined && (
                                <pre className="bg-muted max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{call.output}</pre>
                            )}
                            {call.error !== undefined && <p className="text-destructive text-xs">{call.error}</p>}
                        </div>
                    </details>
                </li>
            ))}
        </ul>
    );
};

/**
 * Settings → Chat → Devices: computers the agent may use through the desktop
 * app (docs/plans/device-execution.md). Pairing happens here; approving calls,
 * shared folders and local MCP servers are managed in the desktop app's own
 * window, which the web page cannot reach.
 */
const DevicesSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { authClient } = useAuth();
    const { data: session } = authClient.useSession();
    const now = useNow();
    const [native, setNative] = useState<NativeDeviceStatus | undefined>(undefined);
    const [pairing, setPairing] = useState(false);
    const { data: devices } = useQuery(crpc.devices.functions.listDevices.queryOptions({}));
    const register = useMutation(crpc.devices.functions.registerDevice.mutationOptions());
    const revoke = useMutation(crpc.devices.functions.revokeDevice.mutationOptions());

    useEffect(() => {
        void getNativeDeviceStatus().then(setNative);
    }, []);

    const pairedHere = native?.deviceId ? devices?.find((device) => device._id === native.deviceId) : undefined;
    const defaultName: Record<NativeDevicePlatform, string> = { linux: t`My Linux computer`, macos: t`My Mac`, windows: t`My Windows PC` };

    const pairThisComputer = async (): Promise<void> => {
        if (!native) {
            return;
        }

        setPairing(true);

        try {
            const { deviceId, secret } = await register.mutateAsync({ name: defaultName[native.platform], platform: native.platform });
            // The secret goes straight to the shell and is never kept here.
            const confirmed = await pairNativeDevice({ accountLabel: session?.user?.email ?? "", deviceId, secret }).catch(() => false);

            if (!confirmed) {
                await revoke.mutateAsync({ deviceId: deviceId as Id<"devices"> });
                toast.info(t`Pairing was cancelled on this computer.`);

                return;
            }

            globalThis.dispatchEvent(new Event(DEVICE_PAIRED_EVENT));
            setNative(await getNativeDeviceStatus());
            toast.success(t`This computer is paired. Choose which folders to share in the desktop app.`);
            await openNativeDeviceSettings();
        } catch {
            toast.error(t`Could not pair this computer. Try again.`);
        } finally {
            setPairing(false);
        }
    };

    return (
        <div className="space-y-6">
            <SettingsCard
                description={t`Let the agent use files, a terminal and local MCP servers on your own computer through the Neore desktop app. Every action asks you on that computer first, and nothing runs from shared chats or background tasks.`}
                title={t`Devices`}
            >
                <CardContent className="space-y-4">
                    {native === undefined && (
                        <p className="text-muted-foreground text-sm">{t`Open Neore in the desktop app to pair this computer. Devices you paired before are listed below.`}</p>
                    )}
                    {native !== undefined && pairedHere === undefined && (
                        <div className="flex flex-wrap items-center gap-3">
                            <p className="text-sm">
                                {native.deviceId ? t`This computer is paired with another account.` : t`This computer is not paired yet.`}
                            </p>
                            <Button
                                aria-busy={pairing}
                                disabled={pairing || session?.user?.isAnonymous === true}
                                onClick={() => {
                                    // `pairThisComputer` reports its own failures.
                                    pairThisComputer().catch(() => {});
                                }}
                            >
                                {t`Use this computer for agent tools`}
                            </Button>
                        </div>
                    )}
                    {pairedHere !== undefined && (
                        <div className="flex flex-wrap items-center gap-3">
                            <p className="text-sm">{t`This computer is paired as “${pairedHere.name}”.`}</p>
                            <Button
                                onClick={() => {
                                    openNativeDeviceSettings().catch(() => {});
                                }}
                                variant="outline"
                            >
                                {t`Shared folders and local servers…`}
                            </Button>
                        </div>
                    )}
                    {devices && devices.length > 0 ? (
                        <ul aria-label={t`Paired devices`}>
                            {devices.map((device) => (
                                <DeviceRow device={device} isThisComputer={device._id === native?.deviceId} key={device._id} now={now} />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-muted-foreground text-sm">{t`No devices paired.`}</p>
                    )}
                </CardContent>
            </SettingsCard>
            <SettingsCard description={t`What the agent asked your devices to do in the last 30 days.`} title={t`Device activity`}>
                <CardContent>
                    <DeviceActivity />
                </CardContent>
            </SettingsCard>
        </div>
    );
};

export default DevicesSettings;

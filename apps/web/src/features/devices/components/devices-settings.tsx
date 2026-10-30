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
import type { NativeDevicePlatform, NativeDeviceStatus, NativeHostReconnect, NativeHostSpec } from "@/lib/native/bridge";
import {
    connectNativeHost,
    disconnectNativeHost,
    getNativeDeviceStatus,
    onNativeDeviceChanged,
    openNativeDeviceSettings,
    pairNativeDevice,
    pairNativeHost,
    probeNativeHost,
} from "@/lib/native/bridge";

import { DEVICE_PAIRED_EVENT } from "../lib/device-events";
import { isDeviceOnline } from "../lib/device-relay";
import DeviceScope from "./device-scope";

interface DeviceView {
    _id: string;
    createdAt: number;
    lastSeenAt?: number;
    name: string;
    platform: NativeDevicePlatform;
    /** Unset: offered in any chat. A list: only threads of these projects (empty: nowhere). */
    projectIds?: string[];
    toolNames: string[];
    /** `ssh`: a server this desktop reaches over SSH and speaks for. */
    transport?: "ssh";
    viaDeviceId?: string;
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

const DeviceRow: FC<{
    connected?: boolean;
    device: DeviceView;
    isThisComputer: boolean;
    now: number;
    onConnectionChange: () => void;
    reconnect?: NativeHostReconnect;
}> = ({ connected, device, isThisComputer, now, onConnectionChange, reconnect }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const [name, setName] = useState(device.name);
    const [confirming, setConfirming] = useState(false);
    const rename = useMutation(crpc.devices.functions.renameDevice.mutationOptions());
    const revoke = useMutation(crpc.devices.functions.revokeDevice.mutationOptions());
    const online = isDeviceOnline(device.lastSeenAt, now);
    const nameId = `device-name-${device._id}`;
    // A server being reconnected is stopped by "Disconnect"; one that gave up is tried again by "Retry" or let go by "Dismiss".
    const stoppable = connected || reconnect?.phase === "waiting" || reconnect?.phase === "connecting";
    let buttonLabel = t`Connect`;

    if (stoppable) {
        buttonLabel = t`Disconnect`;
    } else if (reconnect?.phase === "gaveUp") {
        buttonLabel = t`Retry`;
    }

    const connection = (action: () => Promise<unknown>) => {
        void (async () => {
            try {
                await action();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t`Could not connect to the server.`);
            } finally {
                onConnectionChange();
            }
        })();
    };

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
                {device.transport === "ssh" && <Badge variant="outline">{t`Server over SSH`}</Badge>}
                <Badge variant={online ? "default" : "secondary"}>{online ? t`Online` : t`Offline`}</Badge>
                {reconnect?.phase === "gaveUp" && <Badge variant="destructive">{t`Connection lost`}</Badge>}
                {(reconnect?.phase === "waiting" || reconnect?.phase === "connecting") && <Badge variant="secondary">{t`Reconnecting`}</Badge>}
                {connected !== undefined && (
                    <Button
                        onClick={() => connection(() => (stoppable ? disconnectNativeHost(device._id) : connectNativeHost(device._id)))}
                        size="sm"
                        variant="outline"
                    >
                        {buttonLabel}
                    </Button>
                )}
                {reconnect?.phase === "gaveUp" && (
                    <Button onClick={() => connection(() => disconnectNativeHost(device._id))} size="sm" variant="outline">
                        {t`Dismiss`}
                    </Button>
                )}
                <Button onClick={() => setConfirming(true)} size="sm" variant="outline">
                    {t`Remove`}
                </Button>
            </div>
            <DeviceScope deviceId={device._id} projectIds={device.projectIds} />
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
 * Adds a server this computer reaches over SSH. The shell does the connecting and asks the person at the
 * desktop for everything that matters (connecting at all, trusting the server's key, a key passphrase, the final "add it"), so this
 * form only says where the server is.
 */
const AddServer: FC<{ desktopId: string; onAdded: () => void }> = ({ desktopId, onAdded }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const register = useMutation(crpc.devices.functions.registerDevice.mutationOptions());
    const revoke = useMutation(crpc.devices.functions.revokeDevice.mutationOptions());
    const [busy, setBusy] = useState(false);

    const add = async (form: HTMLFormElement): Promise<void> => {
        const data = new FormData(form);
        const text = (name: string) => String(data.get(name) ?? "").trim();
        const spec: NativeHostSpec = {
            address: text("address"),
            name: text("name"),
            port: Number(text("port") || "22"),
            user: text("user"),
            ...(text("identityFile") && { identityFile: text("identityFile") }),
        };

        setBusy(true);

        try {
            // Connecting comes first: the server's platform is needed to register it.
            const probe = await probeNativeHost(spec);
            const { deviceId, secret } = await register.mutateAsync({ name: spec.name, platform: probe.platform, viaDeviceId: desktopId as Id<"devices"> });
            // The secret goes straight to the shell, which keeps it in this computer's keychain; the server never sees it.
            const confirmed = await pairNativeHost({ deviceId, secret, spec }).catch(() => false);

            if (!confirmed) {
                await revoke.mutateAsync({ deviceId: deviceId as Id<"devices"> });
                toast.info(t`Adding the server was cancelled on this computer.`);

                return;
            }

            form.reset();
            onAdded();
            toast.success(t`Server added. Choose which of its folders to share in the desktop app.`);
            await openNativeDeviceSettings();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Could not add the server.`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            aria-label={t`Add a server over SSH`}
            className="grid max-w-xl gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
                event.preventDefault();
                // `add` reports its own failures.
                add(event.currentTarget).catch(() => {});
            }}
        >
            <div className="space-y-1">
                <Label htmlFor="ssh-name">{t`Name`}</Label>
                <Input id="ssh-name" maxLength={80} name="name" placeholder="build-box" required />
            </div>
            <div className="space-y-1">
                <Label htmlFor="ssh-address">{t`Address`}</Label>
                <Input autoComplete="off" id="ssh-address" maxLength={253} name="address" placeholder="build.example.com" required spellCheck={false} />
            </div>
            <div className="space-y-1">
                <Label htmlFor="ssh-user">{t`User`}</Label>
                <Input autoComplete="off" id="ssh-user" maxLength={32} name="user" required spellCheck={false} />
            </div>
            <div className="space-y-1">
                <Label htmlFor="ssh-port">{t`Port`}</Label>
                <Input defaultValue="22" id="ssh-port" inputMode="numeric" max={65_535} min={1} name="port" type="number" />
            </div>
            <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ssh-key">{t`Key file (optional, absolute path)`}</Label>
                <Input autoComplete="off" id="ssh-key" name="identityFile" placeholder="/Users/me/.ssh/id_ed25519" spellCheck={false} />
                <p className="text-muted-foreground text-xs">{t`Without one, your SSH agent and default keys are used. Passwords are not supported yet.`}</p>
            </div>
            <div>
                <Button aria-busy={busy} disabled={busy} type="submit">
                    {t`Connect and add`}
                </Button>
            </div>
        </form>
    );
};

/**
 * Settings → Chat → Devices: computers the agent may use through the desktop
 * app. Pairing happens here; approving calls,
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

    // Once, and again on each change of the shell (a reconnect in the background, say): the buttons follow it.
    useEffect(
        () =>
            onNativeDeviceChanged(() => {
                void getNativeDeviceStatus().then(setNative);
            }),
        [],
    );

    const pairedHere = native?.deviceId ? devices?.find((device) => device._id === native.deviceId) : undefined;
    const refreshNative = (): void => {
        void getNativeDeviceStatus().then(setNative);
        globalThis.dispatchEvent(new Event(DEVICE_PAIRED_EVENT));
    };
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
                                <DeviceRow
                                    connected={native?.hosts?.find((host) => host.deviceId === device._id)?.connected}
                                    device={device}
                                    isThisComputer={device._id === native?.deviceId}
                                    key={device._id}
                                    now={now}
                                    onConnectionChange={refreshNative}
                                    reconnect={native?.hosts?.find((host) => host.deviceId === device._id)?.reconnect}
                                />
                            ))}
                        </ul>
                    ) : (
                        <p className="text-muted-foreground text-sm">{t`No devices paired.`}</p>
                    )}
                </CardContent>
            </SettingsCard>
            {pairedHere !== undefined && native?.deviceId && (
                <SettingsCard
                    description={t`Let the agent work on a server you reach over SSH, with your own SSH client and keys. Neore asks you to trust the server's key the first time, and every action asks you on this computer before it is sent. The server holds no secret of yours.`}
                    title={t`Servers over SSH`}
                >
                    <CardContent>
                        <AddServer desktopId={native.deviceId} onAdded={refreshNative} />
                    </CardContent>
                </SettingsCard>
            )}
            <SettingsCard description={t`What the agent asked your devices to do in the last 30 days.`} title={t`Device activity`}>
                <CardContent>
                    <DeviceActivity />
                </CardContent>
            </SettingsCard>
        </div>
    );
};

export default DevicesSettings;

import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { executeOnNativeDevice, getNativeDeviceManifest, getNativeDeviceStatus, onNativeDeviceChanged, onNativeDeviceProgress } from "@/lib/native/bridge";

import { DEVICE_PAIRED_EVENT } from "../lib/device-events";
import type { DeviceRelayPorts } from "../lib/device-relay";
import { createDeviceRelay, DEVICE_HEARTBEAT_MS } from "../lib/device-relay";

/**
 * Mounted only inside the desktop shell, for a signed-in account, after first
 * paint (`lib/native/native-bridge.tsx`). While this computer is paired to the
 * signed-in account it:
 *
 * - beats every 30 s, so the backend offers its tools to the agent;
 * - sends the shell's signed tool list whenever it changes;
 * - relays every pending call to the shell and the signed result back, and the
 *   shell's signed progress reports (approval showing, running) in between, so
 *   the chat can say where the call is.
 *
 * Paired to another account (or revoked on the web), the heartbeat answers
 * `paired: false` and nothing else runs.
 */
const DeviceRelay: FC = () => {
    const crpc = useCRPC();
    const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
    const [paired, setPaired] = useState(false);

    const heartbeat = useMutation(crpc.devices.functions.heartbeatDevice.mutationOptions());
    const updateManifest = useMutation(crpc.devices.functions.updateDeviceManifest.mutationOptions());
    const claim = useMutation(crpc.devices.functions.claimDeviceCall.mutationOptions());
    const complete = useMutation(crpc.devices.functions.completeDeviceCall.mutationOptions());
    const release = useMutation(crpc.devices.functions.releaseDeviceCall.mutationOptions());
    const reportProgress = useMutation(crpc.devices.functions.reportDeviceCallProgress.mutationOptions());

    // The mutation functions, read at call time: the relay outlives renders.
    const mutations = useRef({
        claim: claim.mutateAsync,
        complete: complete.mutateAsync,
        heartbeat: heartbeat.mutateAsync,
        release: release.mutateAsync,
        reportProgress: reportProgress.mutateAsync,
        updateManifest: updateManifest.mutateAsync,
    });

    useEffect(() => {
        mutations.current = {
            claim: claim.mutateAsync,
            complete: complete.mutateAsync,
            heartbeat: heartbeat.mutateAsync,
            release: release.mutateAsync,
            reportProgress: reportProgress.mutateAsync,
            updateManifest: updateManifest.mutateAsync,
        };
    });

    // Which device this shell is paired as: now, after a pairing on the Devices page, and after the shell's own changes.
    useEffect(() => {
        const read = () => {
            void getNativeDeviceStatus().then((status) => setDeviceId(status?.deviceId ?? undefined));
        };
        const stop = onNativeDeviceChanged(read);

        globalThis.addEventListener(DEVICE_PAIRED_EVENT, read);

        return () => {
            stop();
            globalThis.removeEventListener(DEVICE_PAIRED_EVENT, read);
        };
    }, []);

    useEffect(() => {
        if (deviceId === undefined) {
            setPaired(false);

            return undefined;
        }

        let cancelled = false;
        const beat = () => {
            void (async () => {
                try {
                    const result = await mutations.current.heartbeat({ deviceId: deviceId as Id<"devices"> });

                    if (!cancelled) {
                        setPaired(result.paired);
                    }
                } catch {
                    // Offline or rate-limited: the next beat tries again.
                }
            })();
        };

        beat();

        const timer = setInterval(beat, DEVICE_HEARTBEAT_MS);

        globalThis.addEventListener("focus", beat);

        return () => {
            cancelled = true;
            clearInterval(timer);
            globalThis.removeEventListener("focus", beat);
        };
    }, [deviceId]);

    // The signed tool list: once paired, and whenever the shell's folders or servers change.
    useEffect(() => {
        if (!paired || deviceId === undefined) {
            return undefined;
        }

        return onNativeDeviceChanged(() => {
            void (async () => {
                const manifest = await getNativeDeviceManifest();

                if (manifest) {
                    await mutations.current.updateManifest({ deviceId: deviceId as Id<"devices">, ...manifest });
                }
            })().catch(() => {
                // A refused manifest leaves the previous tool set in place.
            });
        });
    }, [deviceId, paired]);

    // The shell's signed "approval showing" / "running" reports, relayed as-is.
    useEffect(() => {
        if (!paired || deviceId === undefined) {
            return undefined;
        }

        return onNativeDeviceProgress((report) => {
            mutations.current.reportProgress({ deviceId: deviceId as Id<"devices">, ...report, callId: report.callId as Id<"deviceCalls"> }).catch(() => {
                // Display only: a lost report leaves the chat saying "sent to the device".
            });
        });
    }, [deviceId, paired]);

    // One relay per device; it remembers which calls it already took.
    const relay = useRef<ReturnType<typeof createDeviceRelay> | undefined>(undefined);

    useEffect(() => {
        if (deviceId === undefined) {
            relay.current = undefined;

            return;
        }

        const id = deviceId as Id<"devices">;
        const ports: DeviceRelayPorts = {
            claim: async (callId) => {
                const result = await mutations.current.claim({ callId: callId as Id<"deviceCalls">, deviceId: id });

                return result.claimed;
            },
            complete: async (callId, result) => {
                await mutations.current.complete({ callId: callId as Id<"deviceCalls">, deviceId: id, ...result });
            },
            execute: executeOnNativeDevice,
            release: async (callId, reason) => {
                await mutations.current.release({ callId: callId as Id<"deviceCalls">, deviceId: id, reason });
            },
        };

        relay.current = createDeviceRelay(ports);
    }, [deviceId]);

    // Live: a new call reaches this page as soon as the agent makes it.
    const { data: pending } = useQuery(
        crpc.devices.functions.listPendingDeviceCalls.queryOptions(paired && deviceId !== undefined ? { deviceId: deviceId as Id<"devices"> } : skipToken),
    );

    useEffect(() => {
        if (pending) {
            relay.current?.(pending);
        }
    }, [pending]);

    return null;
};

export default DeviceRelay;

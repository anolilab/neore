import { useEffect, useState } from "react";

import { getNativeDeviceStatus, onNativeDeviceChanged } from "@/lib/native/device-bridge";

/**
 * Whether the Devices settings tab shows its form to add an SSH server: only in the desktop app, on a computer paired with
 * this account. Anywhere else a link to that form lands on a tab without it.
 */
export const useServerFormShown = (devices: ReadonlyArray<{ _id: string }> | undefined): boolean => {
    const [nativeDeviceId, setNativeDeviceId] = useState<string | undefined>(undefined);

    // Once, and again on each change of the shell, as the Devices tab does.
    useEffect(
        () =>
            onNativeDeviceChanged(() => {
                void getNativeDeviceStatus().then((status) => setNativeDeviceId(status?.deviceId ?? undefined));
            }),
        [],
    );

    return nativeDeviceId !== undefined && devices?.some((device) => device._id === nativeDeviceId) === true;
};

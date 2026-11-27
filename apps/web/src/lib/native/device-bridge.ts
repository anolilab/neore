/**
 * The shell's device relay (types in `bridge.ts`). Apart from `bridge.ts` so the web build's first load never carries
 * it: only the lazily loaded devices code imports it.
 */
import type { NativeDeviceProgress, NativeDeviceRelay, NativeDeviceStatus, NativeHostProbe, NativeHostSpec, NativeSigned, UnlistenFunction } from "./bridge";
import { getNative } from "./bridge";

/** Only a shell that advertises `device` has the relay; anywhere else every device call is inert. */
const getDeviceBridge = (): NativeDeviceRelay | undefined => {
    const native = getNative();
    const relay = native?.capabilities.includes("device") ? native.device : undefined;

    return relay !== undefined && typeof relay.execute === "function" ? relay : undefined;
};

/** `undefined` until the shell advertises `device`; also `undefined` when the core failed to load. */
export const getNativeDeviceStatus = async (): Promise<NativeDeviceStatus | undefined> => {
    try {
        return (await getDeviceBridge()?.status()) ?? undefined;
    } catch {
        return undefined;
    }
};

/** `false` until the shell advertises `device`, and when the shell refuses the pairing. */
export const pairNativeDevice = async (pairing: { accountLabel: string; deviceId: string; secret: string }): Promise<boolean> => {
    try {
        return (await getDeviceBridge()?.pair(pairing)) === true;
    } catch {
        return false;
    }
};

/** `undefined` until the shell advertises `device`. With a device id: that server's manifest, signed with its own secret. */
export const getNativeDeviceManifest = async (deviceId?: string): Promise<(NativeSigned & { appVersion?: string }) | undefined> =>
    getDeviceBridge()?.manifest(deviceId);

/**
 * Connects a server that is not paired yet. The shell asks the user to trust its key on first use and for a key
 * passphrase, in its own window. Rejects with the reason when it cannot connect.
 */
export const probeNativeHost = async (spec: NativeHostSpec): Promise<NativeHostProbe> => {
    const relay = getDeviceBridge();

    if (relay === undefined) {
        throw new Error("This desktop app cannot connect to servers");
    }

    return relay.hostProbe(spec);
};

/** Stores the probed server with the secret the backend minted for it. `false` when the user declined in the shell. */
export const pairNativeHost = async (pairing: { deviceId: string; secret: string; spec: NativeHostSpec }): Promise<boolean> => {
    try {
        return (await getDeviceBridge()?.hostPair(pairing)) === true;
    } catch {
        return false;
    }
};

/** Connects a paired server again. Rejects with the reason (a changed host key, a refused login…). */
export const connectNativeHost = async (deviceId: string): Promise<NativeHostProbe | undefined> => getDeviceBridge()?.hostConnect(deviceId);

export const disconnectNativeHost = async (deviceId: string): Promise<void> => {
    try {
        await getDeviceBridge()?.hostDisconnect(deviceId);
    } catch {
        // Already gone.
    }
};

/** Rejects until the shell advertises `device`; otherwise the shell's own rejection reaches the caller. */
export const executeOnNativeDevice = async (call: { envelope: string; signature: string }): Promise<NativeSigned> => {
    const relay = getDeviceBridge();

    if (relay === undefined) {
        throw new Error("This desktop app has no device execution yet");
    }

    return relay.execute(call);
};

/** Opens the shell's local window. A no-op until the shell advertises `device`. */
export const openNativeDeviceSettings = async (): Promise<void> => {
    try {
        await getDeviceBridge()?.openSettings();
    } catch {
        // The window did not open; the user can still open it from the shell's menu.
    }
};

/** Signed progress reports for calls this page relayed; a no-op until the shell advertises `device`. */
export const onNativeDeviceProgress = (handler: (report: NativeDeviceProgress) => void): UnlistenFunction =>
    getDeviceBridge()?.onProgress(handler) ?? (() => {});

/** Calls `handler` once on subscribe, then on each shell change; only the one call outside the shell. */
export const onNativeDeviceChanged = (handler: () => void): UnlistenFunction => {
    handler();

    return getDeviceBridge()?.onChanged(handler) ?? (() => {});
};

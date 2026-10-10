/**
 * The page's half of device execution (docs/plans/device-execution.md): a
 * RELAY between the backend's pending calls and the desktop shell. It claims a
 * call (claim-once, so a second window never runs it twice), hands the signed
 * envelope to the shell and sends the shell's signed result back. It decides
 * nothing: the shell verifies the envelope and asks the user in its own window.
 */
import type { NativeSigned } from "@/lib/native/bridge";

/** Mirrors `DEVICE_ONLINE_WINDOW_MS` in `backend/lunora/devices/lib/constants.ts`. */
export const DEVICE_ONLINE_WINDOW_MS = 75_000;

/** How often the shell's page reports the device as online. */
export const DEVICE_HEARTBEAT_MS = 30_000;

export interface PendingDeviceCall {
    callId: string;
    envelope: string;
    signature: string;
}

export interface DeviceRelayPorts {
    claim: (callId: string) => Promise<boolean>;
    complete: (callId: string, result: NativeSigned) => Promise<void>;
    execute: (call: PendingDeviceCall) => Promise<NativeSigned>;
    /** The shell refused the envelope itself: fail the call now rather than at its deadline. */
    release: (callId: string, reason: string) => Promise<void>;
}

export type DeviceRelayOutcome = "completed" | "not-claimed" | "refused";

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export const relayDeviceCall = async (call: PendingDeviceCall, ports: DeviceRelayPorts): Promise<DeviceRelayOutcome> => {
    if (!(await ports.claim(call.callId))) {
        return "not-claimed";
    }

    let result: NativeSigned;

    try {
        result = await ports.execute(call);
    } catch (error) {
        await ports.release(call.callId, reasonOf(error));

        return "refused";
    }

    await ports.complete(call.callId, result);

    return "completed";
};

/**
 * Relays each call once per page load, however often the live query re-sends
 * the pending list. Calls run concurrently; the shell queues their prompts.
 */
export const createDeviceRelay = (ports: DeviceRelayPorts, onError: (error: unknown) => void = () => {}) => {
    const seen = new Set<string>();

    return (calls: ReadonlyArray<PendingDeviceCall>): void => {
        for (const call of calls) {
            if (seen.has(call.callId)) {
                continue;
            }

            seen.add(call.callId);
            relayDeviceCall(call, ports).catch(onError);
        }
    };
};

export const isDeviceOnline = (lastSeenAt: number | undefined, now: number): boolean => lastSeenAt !== undefined && now - lastSeenAt <= DEVICE_ONLINE_WINDOW_MS;

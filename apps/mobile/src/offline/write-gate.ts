/** Every control that sends something to the server or a host. Offline, all of them are disabled. */
export const WRITE_CONTROLS = ["composer", "send", "approve", "cancel", "start"] as const;

export type WriteControl = (typeof WRITE_CONTROLS)[number];

export const OFFLINE_REASON = "Unavailable offline. Reconnect to send.";

export interface WriteControlState {
    disabled: boolean;
    /** Why the control is disabled; read out with it. */
    reason: string | undefined;
}

// `control` is unused today: every control follows the same rule, but a caller names the one it renders so a
// later per-control rule (a capability gate, say) changes this function and not its callers.
export const writeControlState = (_control: WriteControl, { isOffline }: { isOffline: boolean }): WriteControlState => {
    if (isOffline) {
        return { disabled: true, reason: OFFLINE_REASON };
    }

    return { disabled: false, reason: undefined };
};

export class OfflineWriteError extends Error {
    public constructor() {
        super(OFFLINE_REASON);
        this.name = "OfflineWriteError";
    }
}

/** Runs a write only while online. Offline it throws and the write is dropped, never held back for later. */
export const requireOnline = async <T>({ isOffline }: { isOffline: boolean }, write: () => Promise<T>): Promise<T> => {
    if (isOffline) {
        throw new OfflineWriteError();
    }

    return write();
};

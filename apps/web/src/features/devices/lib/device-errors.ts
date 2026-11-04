import { useSyncExternalStore } from "react";

const MAX_KEPT = 5;

/** How far a computer's clock is from the server's, as the refusal reported it. */
export interface ClockOffset {
    direction: "ahead" | "behind";
    minutes: number;
}

export interface DeviceError {
    /** The size of a clock refusal ("about 12 minutes behind"), when the error carried one. */
    clockOffset?: ClockOffset;
    /** `connection`: what ssh or the shell said about reaching a server (free text, never copied). `service`: a refusal in our own words. */
    kind: "connection" | "service";
    message: string;
}

export interface RecordOptions {
    clockOffset?: ClockOffset;
    kind?: DeviceError["kind"];
}

const EMPTY: DeviceError[] = [];
const errors = new Map<string, DeviceError[]>();
const listeners = new Set<() => void>();

const emit = (): void => {
    for (const listener of listeners) {
        listener();
    }
};

/** Remembers a message shown for a connection (this page load only), newest last. */
export const recordDeviceError = (deviceId: string, message: string, options: RecordOptions = {}): void => {
    const kept = errors.get(deviceId) ?? EMPTY;

    if (kept.at(-1)?.message === message) {
        return;
    }

    errors.set(deviceId, [...kept, { clockOffset: options.clockOffset, kind: options.kind ?? "service", message }].slice(-MAX_KEPT));
    emit();
};

export const clearDeviceErrors = (deviceId: string): void => {
    if (errors.delete(deviceId)) {
        emit();
    }
};

/** A connection that is up again no longer explains anything; refusals of a tool list stay until the next one goes through. */
export const clearConnectionErrors = (deviceId: string): void => {
    const kept = errors.get(deviceId);

    if (kept?.some((error) => error.kind === "connection")) {
        errors.set(
            deviceId,
            kept.filter((error) => error.kind !== "connection"),
        );
        emit();
    }
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

export const useDeviceErrors = (deviceId: string): DeviceError[] =>
    useSyncExternalStore(
        subscribe,
        () => errors.get(deviceId) ?? EMPTY,
        () => EMPTY,
    );

import { useSyncExternalStore } from "react";

const MAX_KEPT = 5;

export interface DeviceError {
    /** The size of a clock refusal ("about 12 minutes behind"), when the error carried one. */
    clockOffset?: string;
    message: string;
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
export const recordDeviceError = (deviceId: string, message: string, clockOffset?: string): void => {
    const kept = errors.get(deviceId) ?? EMPTY;

    if (kept.at(-1)?.message === message) {
        return;
    }

    errors.set(deviceId, [...kept, { clockOffset, message }].slice(-MAX_KEPT));
    emit();
};

export const clearDeviceErrors = (deviceId: string): void => {
    if (errors.delete(deviceId)) {
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

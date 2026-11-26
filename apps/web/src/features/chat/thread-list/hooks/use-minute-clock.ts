import { useSyncExternalStore } from "react";

const MINUTE = 60_000;

const listeners = new Set<() => void>();
const clock: { current: number; timer: ReturnType<typeof setInterval> | undefined } = {
    current: Math.floor(Date.now() / MINUTE) * MINUTE,
    timer: undefined,
};

const tick = (): void => {
    clock.current = Math.floor(Date.now() / MINUTE) * MINUTE;

    for (const listener of listeners) {
        listener();
    }
};

const subscribe = (listener: () => void): (() => void) => {
    if (listeners.size === 0) {
        // Catch up on the minutes missed while nothing was listening.
        clock.current = Math.floor(Date.now() / MINUTE) * MINUTE;
        clock.timer = setInterval(tick, MINUTE);
    }

    listeners.add(listener);

    return () => {
        listeners.delete(listener);

        if (listeners.size === 0 && clock.timer !== undefined) {
            clearInterval(clock.timer);
            clock.timer = undefined;
        }
    };
};

const getSnapshot = (): number => clock.current;

/** The clock to the minute, for the list's relative times: one shared interval for every row, none while no row is mounted. */
const useMinuteClock = (): number => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export default useMinuteClock;

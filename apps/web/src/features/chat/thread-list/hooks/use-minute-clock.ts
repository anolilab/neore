import { useSyncExternalStore } from "react";

const MINUTE = 60_000;

const currentMinute = (): number => Math.floor(Date.now() / MINUTE) * MINUTE;

const listeners = new Set<() => void>();
const clock: { current: number; timer: ReturnType<typeof setTimeout> | undefined } = {
    current: currentMinute(),
    timer: undefined,
};

/** Ticks on each minute boundary, so a row mounted late in a minute does not keep that minute for nearly two. */
const scheduleTick = (): void => {
    clock.timer = setTimeout(
        () => {
            clock.current = currentMinute();

            for (const listener of listeners) {
                listener();
            }

            scheduleTick();
        },
        MINUTE - (Date.now() % MINUTE),
    );
};

const subscribe = (listener: () => void): (() => void) => {
    if (listeners.size === 0) {
        // Catch up on the minutes missed while nothing was listening.
        clock.current = currentMinute();
        scheduleTick();
    }

    listeners.add(listener);

    return () => {
        listeners.delete(listener);

        if (listeners.size === 0 && clock.timer !== undefined) {
            clearTimeout(clock.timer);
            clock.timer = undefined;
        }
    };
};

const getSnapshot = (): number => clock.current;

/** On the server nothing subscribes, so the module's clock would stay at load time: read the minute at render instead. */
const getServerSnapshot = (): number => currentMinute();

/** The clock to the minute, for the list's relative times: one shared timer for every row, none while no row is mounted. */
const useMinuteClock = (): number => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export default useMinuteClock;

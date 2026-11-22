/**
 * The clock the browser cards share: when a deadline from the thread browser's status (on the server's clock) has
 * passed on this device's clock, for the live view card and the "Needs you" card alike.
 */
import { useEffect, useState } from "react";

/** The longest delay a browser timer keeps (2^31 − 1 ms, about 24.8 days); a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** True once `until` has passed; re-renders at that moment, so a card changes without a new server answer. */
export const usePassed = (until: number | undefined): boolean => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (until === undefined || until <= now) {
            return undefined;
        }

        // From the real time, not the last render's: a later `until` would otherwise fire late by the time between. A
        // far-off `until` waits in steps of the longest delay a timer keeps; each step re-arms for what is left.
        const delay = Math.min(Math.max(0, until - Date.now()) + 50, MAX_TIMER_DELAY_MS);
        const timer = setTimeout(() => setNow(Date.now()), delay);

        return () => clearTimeout(timer);
    }, [until, now]);

    return until !== undefined && until <= now;
};

/**
 * How far the server's clock was ahead of this device's when the status answer `now` (the server's time in it) came,
 * at `dataUpdatedAt`: subtract it from a server deadline to get it on this device's clock. Late by the answer's way
 * here, so a deadline is never taken as passed early. When it came is kept per answer: a live query's refetch hands back
 * the same push with a later `dataUpdatedAt`, which would move every deadline later and bring back what has ended.
 */
export const useStatusSkew = (now: number | undefined, dataUpdatedAt: number): number => {
    const [received, setReceived] = useState<{ at: number; now: number } | undefined>(undefined);

    if (now !== undefined && received?.now !== now) {
        setReceived({ at: dataUpdatedAt, now });
    }

    if (now === undefined) {
        return 0;
    }

    return now - (received?.now === now ? received.at : dataUpdatedAt);
};

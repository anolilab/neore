import type { ReactNode } from "react";
import { createContext, use, useEffect, useState } from "react";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const THIRTY_DAYS_MS = 30 * DAY_MS;

export interface DateBoundaries {
    dayKey: string; // YYYY-MM-DD format for cache invalidation
    sevenDaysAgo: number;
    thirtyDaysAgo: number;
    today: number;
    yesterday: number;
}

/**
 * Calculate date boundaries for thread grouping
 * Uses string-based day key for reliable cache invalidation.
 */
export const getDateBoundaries = (): DateBoundaries => {
    const now = new Date();
    const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    // Calculate start of today (midnight)
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayTimestamp = today.getTime();

    // Calculate boundaries
    return {
        dayKey,
        sevenDaysAgo: todayTimestamp - SEVEN_DAYS_MS,
        thirtyDaysAgo: todayTimestamp - THIRTY_DAYS_MS,
        today: todayTimestamp,
        yesterday: todayTimestamp - DAY_MS,
    };
};

const DateBoundariesContext = createContext<DateBoundaries>(getDateBoundaries());

export const DateBoundariesProvider = ({ children }: { children: ReactNode }) => {
    const [boundaries, setBoundaries] = useState<DateBoundaries>(getDateBoundaries);

    useEffect(() => {
        const now = new Date();
        const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();

        // The interval is owned by the effect, not by the timeout callback:
        // returning a function from a `setTimeout` callback clears nothing, so
        // the daily interval used to outlive unmount.
        let interval: ReturnType<typeof setInterval> | undefined;

        const timeout = setTimeout(() => {
            setBoundaries(getDateBoundaries());
            interval = setInterval(() => {
                setBoundaries(getDateBoundaries());
            }, 86_400_000); // 24 hours
        }, msUntilMidnight);

        return () => {
            clearTimeout(timeout);

            if (interval !== undefined) {
                clearInterval(interval);
            }
        };
    }, []);

    return <DateBoundariesContext value={boundaries}>{children}</DateBoundariesContext>;
};

export const useDateBoundaries = () => use(DateBoundariesContext);

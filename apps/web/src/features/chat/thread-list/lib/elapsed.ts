/** How long ago a thread was active, as the unit the row words. Past a week it is a date. */
export type Elapsed = { kind: "date"; value: number } | { kind: "day" | "hour" | "minute"; value: number } | { kind: "now" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** The short form a row's time shows: now, 5m, 2h, 3d, then the date. A time in the future counts as now. */
export const describeElapsed = (timestamp: number, now: number): Elapsed => {
    const elapsed = now - timestamp;

    if (elapsed < MINUTE) {
        return { kind: "now" };
    }

    if (elapsed < HOUR) {
        return { kind: "minute", value: Math.floor(elapsed / MINUTE) };
    }

    if (elapsed < DAY) {
        return { kind: "hour", value: Math.floor(elapsed / HOUR) };
    }

    if (elapsed < WEEK) {
        return { kind: "day", value: Math.floor(elapsed / DAY) };
    }

    return { kind: "date", value: timestamp };
};

/** Owner-only thread state as the list rows carry it: absent for threads the caller does not own. */
export interface ThreadOwnerState {
    awaitingInput?: "approval" | "question";
    lastReplyAt?: number;
    lastViewedAt?: number;
    snoozedUntil?: number;
}

/** Whether the thread holds a reply newer than the last view. */
export const hasUnseenReply = (state: ThreadOwnerState): boolean => state.lastReplyAt !== undefined && state.lastReplyAt > (state.lastViewedAt ?? 0);

export type SnoozeChoice = "hour" | "nextWeek" | "tomorrow";

const HOUR_MS = 60 * 60 * 1000;
const MORNING_HOUR = 9;
const MONDAY = 1;

/** A reply the owner has not seen, in a thread that is neither open nor mid-stream. */
export const hasUnreadReply = (state: ThreadOwnerState, context: { isOpen: boolean; isStreaming: boolean }): boolean =>
    !context.isOpen && !context.isStreaming && hasUnseenReply(state);

export const isSnoozed = (snoozedUntil: number | undefined, now: number): boolean => snoozedUntil !== undefined && snoozedUntil > now;

const morningAfter = (now: Date, daysAhead: number): number => {
    const target = new Date(now);

    target.setDate(target.getDate() + daysAhead);
    target.setHours(MORNING_HOUR, 0, 0, 0);

    return target.getTime();
};

/** When a snooze choice ends, in the caller's local time: an hour on, tomorrow 09:00, or the next Monday 09:00. */
export const snoozeUntil = (choice: SnoozeChoice, now: Date): number => {
    if (choice === "hour") {
        return now.getTime() + HOUR_MS;
    }

    if (choice === "tomorrow") {
        return morningAfter(now, 1);
    }

    return morningAfter(now, (MONDAY + 7 - now.getDay()) % 7 || 7);
};

/** A `datetime-local` value: `YYYY-MM-DDTHH:mm`, local wall-clock time. */
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;

/** The farthest a snooze may end, from now. Mirrors the server's limit (`chat/lib/thread-state-logic.ts`). */
const SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The local clock's offset from UTC at an instant, in milliseconds (east of UTC is positive). */
const offsetAt = (time: number): number => -new Date(time).getTimezoneOffset() * 60_000;

/**
 * Every instant whose local wall-clock time is the given one: none inside a daylight-saving gap, two in the hour a change
 * repeats. The offsets a day either side of the wall time cover both sides of a change.
 */
const instantsOf = (year: number, month: number, day: number, hour: number, minute: number): number[] => {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const instants = new Set([wall - offsetAt(wall + DAY_MS), wall - offsetAt(wall - DAY_MS)]);

    return [...instants].filter((instant) => {
        const date = new Date(instant);

        return (
            date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute
        );
    });
};

/**
 * The time a custom snooze ends, from a `datetime-local` value (local wall-clock time, `YYYY-MM-DDTHH:mm`): the earliest
 * occurrence of that time still in the future. In the hour a change repeats, the second pass is taken once the first has
 * gone by. `undefined` when the value is empty or unreadable, falls in a daylight-saving gap, or is not in the future or
 * is further than the server accepts. The server checks the same range; this only keeps the picker from sending a time
 * it refuses.
 */
export const customSnoozeUntil = (localValue: string, now: Date): number | undefined => {
    if (!LOCAL_DATE_TIME_RE.test(localValue)) {
        return undefined;
    }

    const [datePart = "", timePart = ""] = localValue.split("T", 2);
    const [year = 0, month = 0, day = 0] = datePart.split("-", 3).map(Number);
    const [hour = 0, minute = 0] = timePart.split(":", 2).map(Number);
    const nowMs = now.getTime();
    const usable = instantsOf(year, month, day, hour, minute).filter((instant) => instant > nowMs && instant <= nowMs + SNOOZE_MAX_MS);

    return usable.length > 0 ? Math.min(...usable) : undefined;
};

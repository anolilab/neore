/**
 * Reads the plain cron shapes a suggestion carries (one fixed minute, at most hourly) into the parts a sentence needs.
 * Anything else answers `null` and the caller shows the expression itself. Times are UTC, like every task schedule.
 */
export type ScheduleParts =
    | { hour: number; kind: "daily"; minute: number }
    | { hour: number; kind: "monthly"; minute: number; monthDay: number }
    | { hour: number; kind: "weekdays"; minute: number }
    | { hour: number; kind: "weekly"; minute: number; weekday: number }
    | { kind: "hourly"; minute: number };

const WHOLE_NUMBER = /^\d{1,2}$/;
const WHITESPACE = /\s+/;

const readNumber = (field: string | undefined, max: number): number | null => {
    if (field === undefined || !WHOLE_NUMBER.test(field)) {
        return null;
    }

    const value = Number(field);

    return value <= max ? value : null;
};

/** The day fields of a schedule that fires at a fixed time of day. */
const readDays = (monthDayField: string | undefined, weekdayField: string | undefined, hour: number, minute: number): ScheduleParts | null => {
    if (monthDayField === "*") {
        if (weekdayField === "*") {
            return { hour, kind: "daily", minute };
        }

        if (weekdayField === "1-5") {
            return { hour, kind: "weekdays", minute };
        }

        const weekday = readNumber(weekdayField, 7);

        // Both 0 and 7 are Sunday in cron.
        return weekday === null ? null : { hour, kind: "weekly", minute, weekday: weekday % 7 };
    }

    const monthDay = readNumber(monthDayField, 31);

    return weekdayField === "*" && monthDay !== null && monthDay >= 1 ? { hour, kind: "monthly", minute, monthDay } : null;
};

export const parseSchedule = (cronExpression: string): ScheduleParts | null => {
    const fields = cronExpression.trim().split(WHITESPACE);

    if (fields.length !== 5) {
        return null;
    }

    const [minuteField, hourField, monthDayField, monthField, weekdayField] = fields;
    const minute = readNumber(minuteField, 59);

    if (minute === null || monthField !== "*") {
        return null;
    }

    if (hourField === "*") {
        return monthDayField === "*" && weekdayField === "*" ? { kind: "hourly", minute } : null;
    }

    const hour = readNumber(hourField, 23);

    return hour === null ? null : readDays(monthDayField, weekdayField, hour, minute);
};

export const formatClock = (hour: number, minute: number): string => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

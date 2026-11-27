"use client";

import { useLingui } from "@lingui/react/macro";

import { formatClock, parseSchedule } from "../lib/schedule-text";
import { presetForCron } from "../lib/task-board";

/**
 * Returns a function that words a task's cron expression: the board's own presets first, then the plain daily, weekly and
 * monthly shapes, and the expression itself for anything else (the same words the task card uses).
 */
export const useScheduleLabel = (): ((cronExpression: string) => string) => {
    const { i18n, t } = useLingui();

    return (cronExpression: string): string => {
        const preset = presetForCron(cronExpression);

        if (preset === "daily") {
            return t`Every day at 09:00 UTC`;
        }

        if (preset === "hourly") {
            return t`Every hour`;
        }

        if (preset === "weekdays") {
            return t`Weekdays at 09:00 UTC`;
        }

        if (preset === "weekly") {
            return t`Mondays at 09:00 UTC`;
        }

        const parts = parseSchedule(cronExpression);

        if (parts === null) {
            return t`Repeats (${cronExpression} UTC)`;
        }

        if (parts.kind === "hourly") {
            const { minute } = parts;

            return t`Every hour at minute ${minute}`;
        }

        const time = formatClock(parts.hour, parts.minute);

        if (parts.kind === "daily") {
            return t`Every day at ${time} UTC`;
        }

        if (parts.kind === "weekdays") {
            return t`Weekdays at ${time} UTC`;
        }

        if (parts.kind === "monthly") {
            const { monthDay } = parts;

            return t`Day ${monthDay} of every month at ${time} UTC`;
        }

        // 2024-01-07 was a Sunday.
        const weekday = new Intl.DateTimeFormat(i18n.locale, { timeZone: "UTC", weekday: "long" }).format(new Date(Date.UTC(2024, 0, 7 + parts.weekday)));

        return t`Every ${weekday} at ${time} UTC`;
    };
};

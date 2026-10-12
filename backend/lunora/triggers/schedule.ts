/**
 * Trigger Schedule Provider
 *
 * Cron-driven check that finds all enabled schedule triggers whose
 * nextTriggerAt has passed, fires them, and computes the next run time.
 *
 * Uses a simple cron expression parser for standard 5-field expressions.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";

const WHITESPACE_RE = /\s+/;
const DIGITS_RE = /^\d+$/;
// Max triggers to process per cron run to avoid mutation limits
const TRIGGER_BATCH_SIZE = 25;

const SWITCHED_OFF_REASON = "Schedule must run at most hourly and fire at least once in the next 28 years. It was switched off.";

/**
 * What a due schedule does. One that breaks the hourly rule, or never fires, is
 * switched off with a reason and never runs. This is the policy for triggers
 * armed before the rule, and for any that stop matching. Enabling refuses the
 * same schedules (`setTriggerEnabled`).
 */
export const dueScheduleStep = (
    cronExpression: string | undefined,
    now: number,
): { kind: "run"; nextTime?: number } | { kind: "switchOff"; reason: string } => {
    if (!cronExpression) {
        return { kind: "run" };
    }

    const nextTime = isHourlyOrSlowerCronExpression(cronExpression) ? findNextCronTime(cronExpression, now) : undefined;

    return nextTime === undefined ? { kind: "switchOff", reason: SWITCHED_OFF_REASON } : { kind: "run", nextTime };
};

export const checkDueTriggers = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const { now } = ctx;

        // Tasks ride this every-minute tick instead of declaring a cron of their
        // own: recurrences that are due, and rounds that stopped reporting.
        await ctx.scheduler.runAfter(0, internal.tasks.internal.checkDueTasks, {});

        const dueTriggers = await ctx.runQuery(internal.triggers.functions.getDueScheduleTriggers, { now });

        if (dueTriggers.length === 0) {
            return null;
        }

        // Process only the first batch in this run
        const batch = dueTriggers.slice(0, TRIGGER_BATCH_SIZE);

        for (const trigger of batch) {
            const triggerId = trigger._id;
            const step = dueScheduleStep(trigger.cronExpression, now);

            if (step.kind === "switchOff") {
                await ctx.db.patch(triggerId, { enabled: false, lastError: step.reason, updatedAt: now });

                continue;
            }

            // Schedule the execution as a background action
            void ctx.scheduler.runAfter(0, internal.triggers.execute.executeTrigger, {
                payload: trigger.inputTemplate ?? undefined,
                triggerId,
            });

            // Compute next trigger time
            if (step.nextTime !== undefined) {
                await ctx.db.patch(triggerId, {
                    nextTriggerAt: step.nextTime,
                    updatedAt: now,
                });
            }
        }

        // If more triggers remain, schedule a follow-up run
        if (dueTriggers.length > TRIGGER_BATCH_SIZE) {
            void ctx.scheduler.runAfter(100, internal.triggers.schedule.checkDueTriggers, {});
        }

        return null;
    });

// ─── Simple Cron Expression Parser ──────────────────────────────────────────

/**
 * Searched days ahead: 28 years, the cycle after which a leap day falls on the same
 * weekday again. A schedule on Feb 29 that is a given weekday is up to 28 years out.
 * A gap across a century year that is not a leap year can be longer, and such a
 * schedule is refused as "never fires".
 */
const SEARCH_DAYS = 366 * 28;

/**
 * The first time `expression` fires strictly after `after`, or `undefined` when
 * it never does (an invalid expression, or one like Feb 30). Only whole days that
 * match are searched in detail, so a monthly or yearly schedule costs a day loop,
 * not a minute loop.
 *
 * Supports: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6).
 * Supports: *, specific values, comma-separated lists, ranges (1-5), steps (0/15 * * * *).
 * Day-of-month and day-of-week must BOTH match (AND), unlike standard cron's OR.
 *
 * Returns a timestamp in milliseconds.
 */
export const findNextCronTime = (expression: string, after: number): number | undefined => {
    // Checked as a whole: the field parser reads an unknown token as a wildcard, so
    // `bad 0 * * *` would otherwise come back as a time.
    if (!isValidCronExpression(expression)) {
        return undefined;
    }

    const fields = expression.trim().split(WHITESPACE_RE);

    const [minuteField, hourField, dayField, monthField, dowField] = fields;

    // Sorted, so the first match in the loops below is the earliest one.
    const minutes = parseCronField(minuteField!, 0, 59).sort((a, b) => a - b);
    const hours = parseCronField(hourField!, 0, 23).sort((a, b) => a - b);
    const days = parseCronField(dayField!, 1, 31);
    const months = parseCronField(monthField!, 1, 12);
    const dows = parseCronField(dowField!, 0, 6);

    // The next whole minute after `after`.
    const start = Math.floor((after + 60_000) / 60_000) * 60_000;
    const startDate = new Date(start);

    for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
        // UTC throughout, deliberately: a cron expression here is UTC by contract.
        // Local getters made "0 8,12,18 * * *" depend on the process's time zone.
        const dayStart = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate() + offset);
        const day = new Date(dayStart);

        if (!days.includes(day.getUTCDate()) || !months.includes(day.getUTCMonth() + 1) || !dows.includes(day.getUTCDay())) {
            continue;
        }

        for (const hour of hours) {
            for (const minute of minutes) {
                const candidate = dayStart + hour * 3_600_000 + minute * 60_000;

                if (candidate >= start) {
                    return candidate;
                }
            }
        }
    }

    return undefined;
};

/**
 * {@link findNextCronTime}, or one hour from `after` when there is no match. Only
 * for callers that need a number (recurring tasks). Arming paths must use
 * `findNextCronTime`: the one-hour value would arm a run that was never scheduled.
 */
export const getNextCronTime = (expression: string, after: number): number => findNextCronTime(expression, after) ?? after + 3_600_000;

// `*`, `n`, `*/s`, `n/s` or `a-b`. A stepped range (`1-5/2`) is refused because
// `getNextCronTime` would read it as `1/2` and run far more often than written.
const CRON_PART_RE = /^(?:(?:\*|\d{1,2})(?:\/\d{1,2})?|\d{1,2}-\d{1,2})$/u;

const CRON_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
];

/**
 * The schedule format {@link getNextCronTime} reads: five UTC fields, each `*`,
 * a value, a range or a step, comma-separated. Stricter than the parser, which
 * quietly treats garbage as a wildcard — so an expression that fails here would
 * fire every minute. Triggers and recurring tasks both refuse one at save time.
 */
/**
 * A trigger may fire at most once an hour: the minute field must be one literal
 * minute. A per-minute trigger runs a full agent 1,440 times a day, and nothing
 * else bounds that. The check is on the field's shape rather than on the gap
 * between occurrences, so `0,1,2 * * * *` and `*\/30 * * * *` are refused too.
 */
export const isHourlyOrSlowerCronExpression = (expression: string): boolean => {
    if (!isValidCronExpression(expression)) {
        return false;
    }

    const [minute] = expression.trim().split(WHITESPACE_RE);

    return minute !== undefined && DIGITS_RE.test(minute);
};

export const isValidCronExpression = (expression: string): boolean => {
    const fields = expression.trim().split(WHITESPACE_RE);

    if (fields.length !== 5) {
        return false;
    }

    return fields.every((field, index) => {
        const [min, max] = CRON_RANGES[index]!;

        return field.split(",").every((part) => {
            if (!CRON_PART_RE.test(part)) {
                return false;
            }

            const [range, step] = part.split("/", 2);

            if (step !== undefined && Number(step) < 1) {
                return false;
            }

            if (range === "*") {
                return true;
            }

            const [start, end] = range!.split("-", 2).map(Number);

            return start! >= min && start! <= max && (end === undefined || (end >= start! && end <= max));
        });
    });
};

const parseCronField = (field: string, min: number, max: number): number[] => {
    const values: number[] = [];

    for (const part of field.split(",")) {
        if (part === "*") {
            for (let i = min; i <= max; i += 1) values.push(i);
        } else if (part.includes("/")) {
            const [base, stepString] = part.split("/", 2);
            const step = Number.parseInt(stepString!, 10);

            // Guard against step=0 (infinite loop) or invalid steps
            if (!step || step < 1 || Number.isNaN(step)) {
                continue;
            }

            const start = base === "*" ? min : Number.parseInt(base!, 10);

            if (Number.isNaN(start) || start < min || start > max) {
                continue;
            }

            for (let i = start; i <= max; i += step) {
                values.push(i);
            }
        } else if (part.includes("-")) {
            const [startString, endString] = part.split("-", 2);
            const s = Number.parseInt(startString!, 10);
            const end = Number.parseInt(endString!, 10);

            if (Number.isNaN(s) || Number.isNaN(end)) {
                continue;
            }

            // Clamp to valid range
            const clampedStart = Math.max(s, min);
            const clampedEnd = Math.min(end, max);

            for (let i = clampedStart; i <= clampedEnd; i += 1) values.push(i);
        } else {
            const value = Number.parseInt(part, 10);

            if (!Number.isNaN(value) && value >= min && value <= max) {
                values.push(value);
            }
        }
    }

    // Fallback: if no valid values parsed, treat as wildcard
    if (values.length === 0) {
        for (let i = min; i <= max; i += 1) values.push(i);
    }

    return values;
};

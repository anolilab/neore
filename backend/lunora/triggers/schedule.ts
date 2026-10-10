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
// Max triggers to process per cron run to avoid mutation limits
const TRIGGER_BATCH_SIZE = 25;

export const checkDueTriggers = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const now = ctx.now;

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
            const { cronExpression } = trigger;

            // Schedule the execution as a background action
            void ctx.scheduler.runAfter(0, internal.triggers.execute.executeTrigger, {
                payload: trigger.inputTemplate ?? undefined,
                triggerId,
            });

            // Compute next trigger time
            if (cronExpression) {
                const nextTime = getNextCronTime(cronExpression, now);

                await ctx.db.patch(triggerId, {
                    nextTriggerAt: nextTime,
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
 * Parse a 5-field cron expression and compute the next occurrence after `after`.
 *
 * Supports: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6).
 * Supports: *, specific values, comma-separated lists, ranges (1-5), steps (0/15 * * * *).
 *
 * Returns a timestamp in milliseconds.
 */
export const getNextCronTime = (expression: string, after: number): number => {
    const fields = expression.trim().split(WHITESPACE_RE);

    if (fields.length !== 5) {
        // Invalid cron expression, default to 1 hour from now
        return after + 3_600_000;
    }

    const [minuteField, hourField, dayField, monthField, dowField] = fields;

    const minutes = parseCronField(minuteField!, 0, 59);
    const hours = parseCronField(hourField!, 0, 23);
    const days = parseCronField(dayField!, 1, 31);
    const months = parseCronField(monthField!, 1, 12);
    const dows = parseCronField(dowField!, 0, 6);

    const start = new Date(after + 60_000); // Start from next minute

    start.setUTCSeconds(0, 0);

    // Search up to 31 days ahead (44,640 iterations max, down from 527K)
    // If a cron expression doesn't match within 31 days, it's likely misconfigured
    const maxIterations = 31 * 24 * 60;

    for (let i = 0; i < maxIterations; i += 1) {
        const candidate = new Date(start.getTime() + i * 60_000);
        // UTC getters, deliberately. These were `getMinutes()` / `getHours()` /
        // `getDate()` / `getMonth()` / `getDay()`, which read the RUNTIME's local
        // time zone — so "0 8,12,18 * * *" resolved against whatever TZ the process
        // happened to be in. Cloudflare Workers run as UTC, so production was right
        // by accident and only a developer machine could see it: on Europe/Berlin
        // the schedule test resolved 12:00 to 11:00 UTC. A cron expression here is
        // UTC by contract, and now says so.
        const min = candidate.getUTCMinutes();
        const hr = candidate.getUTCHours();
        const day = candidate.getUTCDate();
        const month = candidate.getUTCMonth() + 1; // 1-indexed
        const dow = candidate.getUTCDay(); // 0=Sunday

        if (minutes.includes(min) && hours.includes(hr) && days.includes(day) && months.includes(month) && dows.includes(dow)) {
            return candidate.getTime();
        }
    }

    // Fallback: 1 hour from now
    return after + 3_600_000;
};

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

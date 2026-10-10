/**
 * When a periodic job is due, for the single-tick cron (`crons.ts:cronTick`).
 *
 * Cloudflare allows at most 3 Cron Triggers per Worker, and this app had six
 * distinct expressions. So only a one-minute trigger is registered, and each
 * periodic job is given a schedule here. A job is due when its most recent
 * scheduled instant ("slot") is later than the slot it last ran for, which
 * `cronRuns` stores per job. Claiming a slot and running for it happen once:
 * a duplicate or late tick finds the slot already claimed.
 *
 * Slots reproduce the cron expressions they replace: interval slots are aligned
 * to the Unix epoch in UTC (hourly = `0 * * * *`, six-hourly = `0 *\/6 * * *`,
 * ten-minutely = `*\/10 * * * *`), daily slots fall on the given UTC time. A tick
 * running a little late still runs the slot it missed, once; a tick that missed
 * several slots of one job runs it once, for the latest — as a cron would.
 *
 * Pure, so the rules are testable without a database or a clock.
 */

export type CronSchedule = { everyMinutes: number; kind: "interval" } | { hourUTC: number; kind: "daily"; minuteUTC: number };

export interface PeriodicJob {
    name: string;
    schedule: CronSchedule;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The most recent instant at or before `now` at which `schedule` fires. */
export const latestSlot = (schedule: CronSchedule, now: number): number => {
    if (schedule.kind === "interval") {
        const every = schedule.everyMinutes * MINUTE_MS;

        return Math.floor(now / every) * every;
    }

    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    const today = dayStart + (schedule.hourUTC * 60 + schedule.minuteUTC) * MINUTE_MS;

    return today <= now ? today : today - DAY_MS;
};

/**
 * The jobs due at `now`, each with the slot it runs for. `lastSlots` holds the
 * slot each job last claimed; a job never claimed is due at once (first deploy,
 * or a job just added), which suits maintenance jobs that are safe at any time.
 */
export const dueJobs = (
    jobs: ReadonlyArray<PeriodicJob>,
    lastSlots: Readonly<Record<string, number | undefined>>,
    now: number,
): { name: string; slot: number }[] =>
    jobs.flatMap((job) => {
        const slot = latestSlot(job.schedule, now);
        const last = lastSlots[job.name];

        return last === undefined || last < slot ? [{ name: job.name, slot }] : [];
    });

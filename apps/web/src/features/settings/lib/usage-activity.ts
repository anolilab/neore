/**
 * The usage page's activity heatmap, as a plain model: 53 week columns of 7
 * day cells (Monday first) ending with the week that holds `today`, each cell
 * bucketed into an intensity level. The components only draw it; this file is
 * pinned by `usage-activity.test.ts`.
 *
 * Day keys are `YYYY-MM-DD` strings throughout — the backend files a reply under
 * the user's local calendar day, and nothing here converts time zones.
 */

export type HeatmapMetric = "cost" | "replies";

/** One active day, as `usage_activity.getActivityHeatmap` returns it. */
export interface ActivityDay {
    costMicrodollars: number;
    date: string;
    replies: number;
    tokens: number;
}

/** 0 = no activity; 1–3 = terciles of the active days' values. */
export type HeatmapLevel = 0 | 1 | 2 | 3;

export interface HeatmapCell {
    costMicrodollars: number;
    date: string;
    /** False for the days after `today` in the last column; drawn as blanks. */
    inRange: boolean;
    level: HeatmapLevel;
    replies: number;
    tokens: number;
}

export interface HeatmapMonth {
    activeDays: number;
    costMicrodollars: number;
    /** `YYYY-MM`. */
    month: string;
    replies: number;
}

export interface HeatmapModel {
    activeDays: number;
    /** The first day drawn (a Monday). */
    fromDate: string;
    /** Per calendar month, oldest first — the screen-reader table and the month axis. */
    months: HeatmapMonth[];
    /** The column each month's label sits over: the first week whose Monday is in that month. */
    monthStarts: { month: string; weekIndex: number }[];
    toDate: string;
    totalCostMicrodollars: number;
    totalReplies: number;
    weeks: HeatmapCell[][];
}

export const HEATMAP_WEEKS = 53;

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (value: number): string => String(value).padStart(2, "0");

/** The browser's local calendar day of `date`. */
export const localDayKey = (date: Date): string => `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** `dayKey` shifted by `days` calendar days. */
export const addDays = (dayKey: string, days: number): string => new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (dayKey: string): number => (new Date(`${dayKey}T00:00:00Z`).getUTCDay() + 6) % 7;

/** The first day of a window of `days` days ending (inclusive) at `today`. */
export const periodStart = (today: string, days: number): string => addDays(today, -(Math.max(1, days) - 1));

/** A UTC `Date` at noon of `dayKey`, for `Intl` formatting that must not shift the day. */
export const dayKeyToDate = (dayKey: string): Date => new Date(`${dayKey}T12:00:00Z`);

const valueOf = (day: Pick<ActivityDay, "costMicrodollars" | "replies">, metric: HeatmapMetric): number =>
    metric === "cost" ? day.costMicrodollars : day.replies;

/** The two tercile cut points of the positive values; a value above the second is level 3. */
export const levelThresholds = (values: ReadonlyArray<number>): [number, number] => {
    const positive = values.filter((value) => value > 0).toSorted((a, b) => a - b);

    if (positive.length === 0) {
        return [0, 0];
    }

    const at = (fraction: number): number => positive[Math.min(positive.length - 1, Math.ceil(positive.length * fraction) - 1)]!;

    return [at(1 / 3), at(2 / 3)];
};

export const levelOf = (value: number, [low, high]: [number, number]): HeatmapLevel => {
    if (value <= 0) {
        return 0;
    }

    if (value <= low) {
        return 1;
    }

    return value <= high ? 2 : 3;
};

export const buildHeatmap = (days: ReadonlyArray<ActivityDay>, today: string, metric: HeatmapMetric): HeatmapModel => {
    const fromDate = addDays(today, -weekdayOf(today) - (HEATMAP_WEEKS - 1) * 7);
    const byDate = new Map<string, ActivityDay>();

    for (const day of days) {
        if (day.date >= fromDate && day.date <= today) {
            byDate.set(day.date, day);
        }
    }

    const thresholds = levelThresholds([...byDate.values()].map((day) => valueOf(day, metric)));
    const weeks: HeatmapCell[][] = [];
    const monthStarts: HeatmapModel["monthStarts"] = [];
    const months = new Map<string, HeatmapMonth>();
    let totalReplies = 0;
    let totalCostMicrodollars = 0;

    for (let week = 0; week < HEATMAP_WEEKS; week += 1) {
        const column: HeatmapCell[] = [];

        for (let weekday = 0; weekday < 7; weekday += 1) {
            const date = addDays(fromDate, week * 7 + weekday);
            const inRange = date <= today;
            const day = inRange ? byDate.get(date) : undefined;
            const replies = day?.replies ?? 0;
            const costMicrodollars = day?.costMicrodollars ?? 0;

            column.push({
                costMicrodollars,
                date,
                inRange,
                level: day ? levelOf(valueOf(day, metric), thresholds) : 0,
                replies,
                tokens: day?.tokens ?? 0,
            });

            if (!inRange) {
                continue;
            }

            const monthKey = date.slice(0, 7);
            const month = months.get(monthKey) ?? { activeDays: 0, costMicrodollars: 0, month: monthKey, replies: 0 };

            if (replies > 0) {
                month.activeDays += 1;
            }

            month.replies += replies;
            month.costMicrodollars += costMicrodollars;
            months.set(monthKey, month);
            totalReplies += replies;
            totalCostMicrodollars += costMicrodollars;
        }

        const monthOfWeek = column[0]!.date.slice(0, 7);

        if (monthStarts.at(-1)?.month !== monthOfWeek) {
            monthStarts.push({ month: monthOfWeek, weekIndex: week });
        }

        weeks.push(column);
    }

    const monthList = [...months.values()];

    return {
        activeDays: monthList.reduce((sum, month) => sum + month.activeDays, 0),
        fromDate,
        months: monthList,
        // The first column's month is usually a partial week of it; label it only
        // when the next label is at least three columns away, so labels never collide.
        monthStarts: monthStarts.filter((_start, index) => index > 0 || (monthStarts[1]?.weekIndex ?? HEATMAP_WEEKS) >= 3),
        toDate: today,
        totalCostMicrodollars,
        totalReplies,
        weeks,
    };
};

/** A microdollar amount as US dollars — four decimals below $1, where sub-cent spend is the norm. */
export const formatUsd = (microdollars: number, locale: string): string => {
    const dollars = microdollars / 1_000_000;

    return new Intl.NumberFormat(locale, {
        currency: "USD",
        maximumFractionDigits: dollars > 0 && dollars < 1 ? 4 : 2,
        minimumFractionDigits: 2,
        style: "currency",
    }).format(dollars);
};

/** Arrow-key offsets in days: a row is a weekday, a column a week. */
const STEPS: Record<string, number> = { ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1 };

/** The cell a keyboard step lands on: ±1 day vertically, ±1 week horizontally, clamped to the drawn, in-range days. */
export const stepDay = (current: string, key: string, model: Pick<HeatmapModel, "fromDate" | "toDate">): string | undefined => {
    if (key === "Home") {
        return model.fromDate;
    }

    if (key === "End") {
        return model.toDate;
    }

    const step = STEPS[key];

    if (step === undefined) {
        return undefined;
    }

    const next = addDays(current, step);

    if (next < model.fromDate) {
        return model.fromDate;
    }

    if (next > model.toDate) {
        return model.toDate;
    }

    return next;
};

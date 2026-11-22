/**
 * The gateway's provider prompt-cache readings rolled up for the admin card: the share of prompt tokens a provider
 * served from its own cache, per day in the admin's time zone and for the whole window.
 */

export interface CacheCounts {
    cachedTokens: number;
    promptTokens: number;
    requests: number;
}

export interface QuarterReading extends CacheCounts {
    /** The quarter hour's UTC start, as an ISO string. */
    start: string;
}

/** The share of prompt tokens served from the provider's cache, or `null` when no prompt tokens were sent. */
export const cachedShare = (counts: CacheCounts): number | null => (counts.promptTokens === 0 ? null : counts.cachedTokens / counts.promptTokens);

/** The counts of `readings` summed. */
export const sumCounts = (readings: CacheCounts[]): CacheCounts => {
    const sum: CacheCounts = { cachedTokens: 0, promptTokens: 0, requests: 0 };

    for (const reading of readings) {
        sum.cachedTokens += reading.cachedTokens;
        sum.promptTokens += reading.promptTokens;
        sum.requests += reading.requests;
    }

    return sum;
};

const isTimeZone = (zone: string): boolean => {
    try {
        // Throws a RangeError for a zone `Intl` does not know.
        new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);

        return true;
    } catch {
        return false;
    }
};

/** The browser's time zone. Read it only after hydration: the server's zone is not the browser's. */
export const browserTimeZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `configured` (the user's time zone setting) when `Intl` knows it, else `fallback` (the browser's zone once hydrated), else UTC. */
export const resolveTimeZone = (configured: string | null | undefined, fallback?: string): string => {
    if (configured && isTimeZone(configured)) {
        return configured;
    }

    return fallback && isTimeZone(fallback) ? fallback : "UTC";
};

const partsIn = (iso: string, timeZone: string): Partial<Record<Intl.DateTimeFormatPartTypes, string>> => {
    const parts = new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        timeZone,
        year: "numeric",
    }).formatToParts(new Date(iso));

    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
};

/** `YYYY-MM-DD` of `iso` in `timeZone`, from its parts, whatever order a locale would print them in. */
export const dayKeyIn = (iso: string, timeZone: string): string => {
    const parts = partsIn(iso, timeZone);

    return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
};

const MINUTE_MS = 60_000;

const sumInto = <Key>(groups: Map<Key, CacheCounts>, key: Key, counts: CacheCounts): void => {
    groups.set(key, sumCounts([groups.get(key) ?? { cachedTokens: 0, promptTokens: 0, requests: 0 }, counts]));
};

/**
 * Quarter hours summed into the hours of `timeZone`, oldest first; `start` is the local hour's start as an ISO string.
 * Every zone's offset is a whole number of quarter hours, so a quarter never straddles two local hours, and an hour
 * that repeats when clocks go back stays two hours, since each has its own UTC start.
 */
export const byHour = (quarters: QuarterReading[], timeZone: string): (CacheCounts & { start: string })[] => {
    const hours = new Map<number, CacheCounts>();

    for (const quarter of quarters) {
        const startMs = Date.parse(quarter.start);
        const localMinute = Number(partsIn(quarter.start, timeZone).minute ?? 0);

        sumInto(hours, startMs - localMinute * MINUTE_MS, quarter);
    }

    return [...hours]
        .toSorted(([a], [b]) => a - b)
        .map(([startMs, counts]) => {
            return { ...counts, start: new Date(startMs).toISOString() };
        });
};

/** Quarter hours summed by calendar day (`YYYY-MM-DD`) in `timeZone`, newest day first. */
export const byDay = (quarters: QuarterReading[], timeZone: string): (CacheCounts & { day: string })[] => {
    const days = new Map<string, CacheCounts>();

    for (const quarter of quarters) {
        sumInto(days, dayKeyIn(quarter.start, timeZone), quarter);
    }

    return [...days]
        .map(([day, counts]) => {
            return { ...counts, day };
        })
        .toSorted((a, b) => b.day.localeCompare(a.day));
};

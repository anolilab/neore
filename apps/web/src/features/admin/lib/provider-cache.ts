/**
 * The gateway's provider prompt-cache readings rolled up for the admin card: the share of prompt tokens a provider
 * served from its own cache, per day in the admin's time zone and for the whole window.
 */

export interface CacheCounts {
    cachedTokens: number;
    promptTokens: number;
    requests: number;
}

export interface HourReading extends CacheCounts {
    /** The hour's UTC start, as an ISO string. */
    hour: string;
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

/** `configured` (the user's time zone setting) when `Intl` knows it, else the browser's zone, else UTC. */
export const resolveTimeZone = (configured: string | null | undefined): string => {
    if (configured && isTimeZone(configured)) {
        return configured;
    }

    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
};

/** `YYYY-MM-DD` of `iso` in `timeZone`, from its parts, whatever order a locale would print them in. */
export const dayKeyIn = (iso: string, timeZone: string): string => {
    const parts = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" }).formatToParts(new Date(iso));
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? "";

    return `${part("year")}-${part("month")}-${part("day")}`;
};

/**
 * Hours summed by calendar day (`YYYY-MM-DD`) in `timeZone`, newest day first. An hour goes to the day its start falls
 * on; in a zone with a half-hour offset, the hour that crosses midnight stays whole on its first day.
 */
export const byDay = (hours: HourReading[], timeZone: string): (CacheCounts & { day: string })[] => {
    const days = new Map<string, CacheCounts>();

    for (const hour of hours) {
        const day = dayKeyIn(hour.hour, timeZone);

        days.set(day, sumCounts([days.get(day) ?? { cachedTokens: 0, promptTokens: 0, requests: 0 }, hour]));
    }

    return [...days]
        .map(([day, counts]) => {
            return { ...counts, day };
        })
        .toSorted((a, b) => b.day.localeCompare(a.day));
};

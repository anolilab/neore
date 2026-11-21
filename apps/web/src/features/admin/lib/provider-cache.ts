/**
 * The gateway's provider prompt-cache readings rolled up for the admin card: the share of prompt tokens a provider
 * served from its own cache, per UTC day and for the whole window.
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

/** Hours summed by UTC day (`YYYY-MM-DD`), newest day first. */
export const byDay = (hours: HourReading[]): (CacheCounts & { day: string })[] => {
    const days = new Map<string, CacheCounts>();

    for (const hour of hours) {
        const day = hour.hour.slice(0, 10);

        days.set(day, sumCounts([days.get(day) ?? { cachedTokens: 0, promptTokens: 0, requests: 0 }, hour]));
    }

    return [...days]
        .map(([day, counts]) => {
            return { ...counts, day };
        })
        .toSorted((a, b) => b.day.localeCompare(a.day));
};

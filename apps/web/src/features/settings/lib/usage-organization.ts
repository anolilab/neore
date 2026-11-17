/**
 * The usage page's organization view reads its members a page at a time
 * (`usage_organization.getOrganizationProjectUsage`): each call sums one page of
 * members' shards. This adds the pages up. Pinned by `usage-organization.test.ts`.
 */

export interface OrganizationProjectTotal {
    costMicrodollars: number;
    projectKey: string;
    replies: number;
    title: string;
    tokens: number;
}

/** The replies of projects the organization no longer has, in one total: no project is named. */
export interface OrganizationRemovedTotal {
    costMicrodollars: number;
    replies: number;
    tokens: number;
}

export interface OrganizationUsagePage {
    nextCursor?: string;
    projects: OrganizationProjectTotal[];
    removed?: OrganizationRemovedTotal;
    /** The projects too few members of the view name, folded into one total: no project is named. */
    small?: OrganizationRemovedTotal;
    truncated: boolean;
}

/** Pages read at most: past it the result says `truncated`. */
export const MAX_ORGANIZATION_PAGES = 40;

/** Every page from the first, summed per project, costliest first. */
export const sumOrganizationUsage = async (fetchPage: (cursor: string | undefined) => Promise<OrganizationUsagePage>): Promise<OrganizationUsagePage> => {
    const sums = new Map<string, OrganizationProjectTotal>();
    const removed: OrganizationRemovedTotal = { costMicrodollars: 0, replies: 0, tokens: 0 };
    const small: OrganizationRemovedTotal = { costMicrodollars: 0, replies: 0, tokens: 0 };
    let truncated = false;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_ORGANIZATION_PAGES; page += 1) {
        const result = await fetchPage(cursor);

        truncated ||= result.truncated;

        for (const project of result.projects) {
            const sum = sums.get(project.projectKey) ?? { ...project, costMicrodollars: 0, replies: 0, tokens: 0 };

            sum.costMicrodollars += project.costMicrodollars;
            sum.replies += project.replies;
            sum.tokens += project.tokens;
            sums.set(project.projectKey, sum);
        }

        if (result.removed) {
            removed.costMicrodollars += result.removed.costMicrodollars;
            removed.replies += result.removed.replies;
            removed.tokens += result.removed.tokens;
        }

        if (result.small) {
            small.costMicrodollars += result.small.costMicrodollars;
            small.replies += result.small.replies;
            small.tokens += result.small.tokens;
        }

        cursor = result.nextCursor;

        if (cursor === undefined) {
            break;
        }
    }

    return {
        projects: [...sums.values()].toSorted((a, b) => b.costMicrodollars - a.costMicrodollars || b.replies - a.replies || a.title.localeCompare(b.title)),
        ...(small.replies > 0 && { small }),
        ...(removed.replies > 0 && { removed }),
        truncated: truncated || cursor !== undefined,
    };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The zone's wall-clock parts at `instant`: its calendar day, and the clock time as a UTC-style instant. */
const zoneWallClock = (instant: number, timeZone: string): { dayKey: string; wallClockAsUtc: number } => {
    const parts = new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        second: "2-digit",
        timeZone,
        year: "numeric",
    }).formatToParts(new Date(instant));
    const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const year = value("year");
    const month = value("month");
    const day = value("day");

    return {
        dayKey: `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        wallClockAsUtc: Date.UTC(year, month - 1, day, value("hour"), value("minute"), value("second")),
    };
};

/** The zone if the runtime knows it, else UTC: a zone it does not know must not block the view. */
const knownZone = (timeZone: string): string => {
    try {
        return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    } catch {
        return "UTC";
    }
};

/**
 * The instant (epoch ms) a day starts in `timeZone`: its midnight there. The organization view's period starts at the viewer's midnight,
 * so every member's replies are counted over the same stretch of time, whatever their own zone. A zone that moves its clocks at midnight
 * may have no midnight that day: then the day starts at the change. Of the instants that fall on the day, the earliest is used.
 */
export const startOfDayInZone = (dayKey: string, timeZone: string): number => {
    const zone = knownZone(timeZone);
    const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
    const wall = Date.UTC(year, month - 1, day);
    // The zone's offset at a guess instant: the wall clock there, less the instant itself.
    const offsetAt = (guess: number): number => zoneWallClock(guess, zone).wallClockAsUtc - Math.floor(guess / 1000) * 1000;
    // The offsets a day before, on, and a day after the date: a change at midnight makes them differ, and each may place the start.
    const candidates = [wall - DAY_MS, wall, wall + DAY_MS].map((guess) => wall - offsetAt(guess));
    const onDay = candidates.filter((instant) => zoneWallClock(instant, zone).dayKey === dayKey);

    return onDay.length > 0 ? Math.min(...onDay) : Math.min(...candidates);
};
